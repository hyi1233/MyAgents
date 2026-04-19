//! Legacy CronTask → new-model Task upgrade primitive (PRD §11.4).
//!
//! v0.1.68 CronTasks don't have a `task_id` back-pointer and so surface in
//! the Task Center as "遗留" rows. This module turns them into proper
//! new-model Tasks, preserving schedule / prompt / workspace / end
//! conditions / runtime config — the existing CronTask keeps running, we
//! just wire both-sided back-pointers.
//!
//! Why a Rust primitive instead of the renderer orchestrating four IPC
//! calls?
//!
//! The first upgrade attempt lived in TypeScript and hit two separate
//! wire-format mismatches back-to-back (`deadline` ISO-string vs i64;
//! `run_mode` snake vs kebab). Both are symptoms of the same class of
//! bug: two namesake types in `task::*` and `cron_task::*` evolve with
//! different serde conventions, and whenever the renderer copies a field
//! from one side to the other, serde at the receiver rejects it. Boundary
//! transforms in TS paper over each case but can't prevent the next one.
//!
//! Here the conversion is strongly typed Rust-to-Rust — no JSON
//! round-trip. If someone adds a `cron_task::RunMode::Whatever` variant
//! without a `task::TaskRunMode` counterpart, the compiler refuses to
//! build `run_mode_from_cron()` below. Same for every other field:
//! conversions that drift produce a build error at CI time, not a
//! runtime failure on the user's first opened overlay.
//!
//! Concurrency + atomicity: the whole pipeline (thought creation → task
//! creation → forward pointer → back pointer) lives inside a single
//! `async fn` with explicit rollback on any failure path. The back
//! pointer is written with `require_null = true`, so two concurrent
//! upgrade callers (auto sweep + manual button, two open windows) can't
//! both "win" — the loser sees `ALREADY_LINKED`, rolls back the partial
//! Thought/Task it just created, and bubbles the error to the caller.

use crate::cron_task;
use crate::task;
use crate::thought;
use crate::ulog_info;

/// Map a CronTask's `RunMode` to the Task-side enum. Strongly typed so
/// an added variant on either side becomes a compile error here, not a
/// runtime serde failure later.
fn run_mode_from_cron(rm: &cron_task::RunMode) -> task::TaskRunMode {
    match rm {
        cron_task::RunMode::SingleSession => task::TaskRunMode::SingleSession,
        cron_task::RunMode::NewSession => task::TaskRunMode::NewSession,
    }
}

/// Map a CronTask's `EndConditions` (deadline as `DateTime<Utc>`) to the
/// Task-side shape (deadline as `i64` ms-epoch). The only field that
/// actually needs transforming is `deadline`; the rest pass through.
fn end_conditions_from_cron(ec: &cron_task::EndConditions) -> task::TaskEndConditions {
    task::TaskEndConditions {
        deadline: ec.deadline.map(|dt| dt.timestamp_millis()),
        max_executions: ec.max_executions,
        ai_can_exit: ec.ai_can_exit,
    }
}

/// Derive the Task's `execution_mode` from the cron's schedule kind.
/// `At` → one-shot → `Scheduled`; `Loop` → `Loop`; everything else
/// (`Every` / `Cron` / unset) → `Recurring`. The concrete interval /
/// expression lives on the CronTask; the new Task just remembers the
/// category.
fn execution_mode_from_cron_schedule(
    schedule: &Option<cron_task::CronSchedule>,
) -> task::TaskExecutionMode {
    match schedule {
        Some(cron_task::CronSchedule::At { .. }) => task::TaskExecutionMode::Scheduled,
        Some(cron_task::CronSchedule::Loop) => task::TaskExecutionMode::Loop,
        _ => task::TaskExecutionMode::Recurring,
    }
}

/// Build a Task-side `NotificationConfig` from the cron's notification
/// surface (which lives as separate fields on CronTask, not a nested
/// struct). `CronDelivery.platform` has no Task-side counterpart — the
/// channel id carries the platform implicitly via the bot registry.
fn notification_from_cron(
    notify_enabled: bool,
    delivery: &Option<cron_task::CronDelivery>,
) -> task::NotificationConfig {
    task::NotificationConfig {
        desktop: notify_enabled,
        bot_channel_id: delivery.as_ref().map(|d| d.bot_id.clone()),
        bot_thread: delivery.as_ref().map(|d| d.chat_id.clone()),
        events: Some(vec![
            "done".to_string(),
            "blocked".to_string(),
            "endCondition".to_string(),
        ]),
    }
}

/// Derive a human-readable Task name from the cron. Prefers the
/// explicit `name` field; falls back to the first non-empty line of the
/// prompt, truncated to 60 codepoints for the task card.
fn derive_task_name(cron: &cron_task::CronTask) -> String {
    if let Some(name) = cron.name.as_deref() {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return truncate_chars(trimmed, 120);
        }
    }
    let first_line = cron
        .prompt
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("未命名定时任务")
        .trim();
    truncate_chars(first_line, 60)
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let keep: String = s.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", keep)
}

/// Upgrade result returned to the renderer.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeResult {
    pub task: task::Task,
    pub thought_id: String,
}

/// Upgrade one legacy CronTask to a new-model Task.
///
/// The renderer resolves `workspace_path → workspace_id` from its config
/// and passes the id in (Rust doesn't have a clean cross-process view of
/// the projects list). Everything else — schedule mapping, end-condition
/// shape conversion, rollback — happens server-side under a single
/// `async fn`.
pub async fn upgrade_legacy_cron(
    task_store: &task::TaskStore,
    thought_store: &thought::ThoughtStore,
    cron_task_id: &str,
    workspace_id: &str,
) -> Result<UpgradeResult, String> {
    let manager = cron_task::get_cron_task_manager();
    let cron = manager
        .get_task(cron_task_id)
        .await
        .ok_or_else(|| format!("CronTask not found: {}", cron_task_id))?;

    // Early-out if this cron is already linked. The back-pointer setter
    // catches this concurrently, but checking up front avoids the
    // Thought/Task side effects of a doomed attempt.
    if let Some(existing_task_id) = &cron.task_id {
        return Err(format!(
            "ALREADY_LINKED: CronTask {} is already linked to Task {}",
            cron_task_id, existing_task_id
        ));
    }

    let prompt = cron.prompt.trim();
    if prompt.is_empty() {
        return Err("CronTask has an empty prompt; refusing to upgrade".to_string());
    }

    // Step 1 — mint a source Thought. v1 requires every Task to reference
    // a Thought (PRD §3.2); for legacy upgrades we create one whose
    // content is the cron's original prompt.
    let thought = thought_store
        .create(thought::ThoughtCreateInput {
            content: prompt.to_string(),
            images: vec![],
        })
        .await
        .map_err(|e| format!("create source thought: {}", e))?;

    // Step 2 — build the Task input using strongly-typed Rust
    // conversions. Any field drift between the cron- and task- side
    // enums produces a compile error in the helpers above.
    let execution_mode = execution_mode_from_cron_schedule(&cron.schedule);
    let run_mode = Some(run_mode_from_cron(&cron.run_mode));
    let end_conditions = Some(end_conditions_from_cron(&cron.end_conditions));
    let notification = Some(notification_from_cron(cron.notify_enabled, &cron.delivery));

    let input = task::TaskCreateDirectInput {
        name: derive_task_name(&cron),
        executor: task::TaskExecutor::Agent,
        description: None,
        workspace_id: workspace_id.to_string(),
        workspace_path: cron.workspace_path.clone(),
        task_md_content: cron.prompt.clone(),
        execution_mode,
        run_mode,
        end_conditions,
        runtime: cron.runtime.clone(),
        runtime_config: cron.runtime_config.clone(),
        source_thought_id: Some(thought.id.clone()),
        tags: vec![],
        notification,
    };

    // Step 3 — create the Task. On failure, clean up the thought.
    let task = match task_store.create_direct(input).await {
        Ok(t) => t,
        Err(e) => {
            if let Err(cleanup) = thought_store.delete(&thought.id).await {
                ulog_info!(
                    "[legacy-upgrade] rollback: thought delete failed after task-create error: {}",
                    cleanup
                );
            }
            return Err(format!("create task: {}", e));
        }
    };

    // Step 4 — forward pointer Task → CronTask.
    if let Err(e) = task_store
        .set_cron_task_id(&task.id, Some(cron_task_id.to_string()))
        .await
    {
        let _ = task_store.delete(&task.id).await;
        let _ = thought_store.delete(&thought.id).await;
        return Err(format!("set Task.cron_task_id: {}", e));
    }

    // Step 5 — back pointer CronTask → Task, with link-if-null guard.
    // When two upgrade flows race on the same cron, the loser sees
    // `ALREADY_LINKED` here and we roll back everything we created in
    // this attempt. The winner has already left the cron linked to
    // their Task; ours becomes an orphan we clean up now.
    if let Err(e) = manager
        .set_task_id(cron_task_id, Some(task.id.clone()), true)
        .await
    {
        let _ = task_store.set_cron_task_id(&task.id, None).await;
        let _ = task_store.delete(&task.id).await;
        let _ = thought_store.delete(&thought.id).await;
        return Err(format!("set CronTask.task_id: {}", e));
    }

    ulog_info!(
        "[legacy-upgrade] cron {} → task {} (thought {})",
        cron_task_id,
        task.id,
        thought.id
    );

    Ok(UpgradeResult {
        task,
        thought_id: thought.id,
    })
}

/// Tauri command — thin wrapper around `upgrade_legacy_cron`.
#[tauri::command]
pub async fn cmd_task_upgrade_legacy_cron(
    task_state: tauri::State<'_, task::ManagedTaskStore>,
    thought_state: tauri::State<'_, thought::ManagedThoughtStore>,
    cron_task_id: String,
    workspace_id: String,
) -> Result<UpgradeResult, String> {
    upgrade_legacy_cron(
        &task_state,
        &thought_state,
        &cron_task_id,
        &workspace_id,
    )
    .await
}

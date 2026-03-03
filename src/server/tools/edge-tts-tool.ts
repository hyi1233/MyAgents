// Edge TTS MCP Tool — Free text-to-speech using Microsoft Edge's online TTS API
// In-process MCP server (same pattern as gemini-image-tool)

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// MCP Tool Result type (matches @modelcontextprotocol/sdk/types.js CallToolResult)
type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

// ============= Configuration =============

const MAX_TEXT_LENGTH = 10000;

interface EdgeTtsConfig {
  defaultVoice: string;
  defaultRate: string;
  defaultVolume: string;
  defaultPitch: string;
  defaultOutputFormat: string;
}

let edgeTtsConfig: EdgeTtsConfig | null = null;

export function setEdgeTtsConfig(cfg: EdgeTtsConfig): void {
  edgeTtsConfig = cfg;
  console.log(`[edge-tts] Config set: voice=${cfg.defaultVoice}, format=${cfg.defaultOutputFormat}`);
}

export function getEdgeTtsConfig(): EdgeTtsConfig | null {
  return edgeTtsConfig;
}

export function clearEdgeTtsConfig(): void {
  edgeTtsConfig = null;
  console.log('[edge-tts] Config cleared');
}

// ============= Directories =============

function getGeneratedAudioDir(): string {
  const dir = join(homedir(), '.myagents', 'generated_audio');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ============= Format Helpers =============

/** Get file extension from edge-tts output format string */
function getExtFromFormat(format: string): string {
  if (format.includes('mp3') || format.includes('mpeg')) return 'mp3';
  if (format.includes('webm')) return 'webm';
  if (format.includes('ogg')) return 'ogg';
  if (format.includes('wav') || format.includes('pcm')) return 'wav';
  return 'mp3';
}

/** Format file size for display */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ============= Tool Handlers =============

async function textToSpeechHandler(input: {
  text: string;
  voice?: string;
  rate?: string;
  volume?: string;
  pitch?: string;
}): Promise<CallToolResult> {
  if (!edgeTtsConfig) {
    return {
      content: [{ type: 'text', text: 'Error: Edge TTS is not configured. Please enable it in Settings.' }],
      isError: true,
    };
  }

  const { text, voice, rate, volume, pitch } = input;

  if (!text.trim()) {
    return {
      content: [{ type: 'text', text: 'Error: Text cannot be empty.' }],
      isError: true,
    };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return {
      content: [{ type: 'text', text: `Error: Text too long (${text.length} chars). Maximum is ${MAX_TEXT_LENGTH} characters.` }],
      isError: true,
    };
  }

  const selectedVoice = voice || edgeTtsConfig.defaultVoice;
  const selectedRate = rate || edgeTtsConfig.defaultRate;
  const selectedVolume = volume || edgeTtsConfig.defaultVolume;
  const selectedPitch = pitch || edgeTtsConfig.defaultPitch;
  const outputFormat = edgeTtsConfig.defaultOutputFormat;

  try {
    const { EdgeTTS } = await import('@andresaya/edge-tts');
    const tts = new EdgeTTS();

    await tts.synthesize(text, selectedVoice, {
      rate: selectedRate,
      volume: selectedVolume,
      pitch: selectedPitch,
      outputFormat,
    });

    const audioBuffer = await tts.toBuffer();
    const ext = getExtFromFormat(outputFormat);
    const fileName = `tts_${randomUUID().substring(0, 8)}.${ext}`;
    const filePath = join(getGeneratedAudioDir(), fileName);

    writeFileSync(filePath, audioBuffer);

    const sizeBytes = audioBuffer.length;
    const textPreview = text.length > 50 ? text.substring(0, 50) + '...' : text;

    // Estimate duration: for mp3 at ~48kbps, duration ≈ bytes / (48000/8)
    // This is a rough estimate; actual duration depends on format and bitrate
    const bitrate = outputFormat.match(/(\d+)kbitrate/)?.[1];
    const bitrateKbps = bitrate ? parseInt(bitrate, 10) : 48;
    const estimatedDuration = (sizeBytes / (bitrateKbps * 1000 / 8)).toFixed(1);

    const result = [
      '语音已生成。',
      '',
      `filePath: ${filePath}`,
      `voice: ${selectedVoice}`,
      `duration: ${estimatedDuration}s`,
      `format: ${ext}`,
      `size: ${formatSize(sizeBytes)}`,
      `rate: ${selectedRate}`,
      `volume: ${selectedVolume}`,
      `pitch: ${selectedPitch}`,
      `textPreview: ${textPreview}`,
    ].join('\n');

    console.log(`[edge-tts] Generated: ${fileName}, voice=${selectedVoice}, size=${formatSize(sizeBytes)}`);
    return { content: [{ type: 'text', text: result }] };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[edge-tts] Synthesis error:`, errMsg);
    return {
      content: [{ type: 'text', text: `Error: Failed to synthesize speech. ${errMsg}` }],
      isError: true,
    };
  }
}

async function listVoicesHandler(input: {
  language?: string;
  gender?: string;
}): Promise<CallToolResult> {
  try {
    const { EdgeTTS } = await import('@andresaya/edge-tts');
    const tts = new EdgeTTS();
    const voices = await tts.getVoices();

    let filtered = voices;

    if (input.language) {
      const lang = input.language.toLowerCase();
      filtered = filtered.filter((v: { Locale: string }) =>
        v.Locale.toLowerCase().startsWith(lang)
      );
    }

    if (input.gender) {
      const gender = input.gender.toLowerCase();
      filtered = filtered.filter((v: { Gender: string }) =>
        v.Gender.toLowerCase() === gender
      );
    }

    if (filtered.length === 0) {
      return {
        content: [{ type: 'text', text: `No voices found matching the criteria. Try a broader language code (e.g., 'zh' instead of 'zh-CN') or omit the gender filter.` }],
      };
    }

    const lines = filtered.map((v: { ShortName: string; Gender: string; Locale: string; FriendlyName: string }) =>
      `${v.ShortName} | ${v.Gender} | ${v.Locale} | ${v.FriendlyName}`
    );

    const header = `Found ${filtered.length} voice(s):\n\nShortName | Gender | Locale | FriendlyName\n${'─'.repeat(60)}`;
    return {
      content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[edge-tts] List voices error:`, errMsg);
    return {
      content: [{ type: 'text', text: `Error: Failed to list voices. ${errMsg}` }],
      isError: true,
    };
  }
}

// ============= Standalone synthesis (for Settings preview) =============

export async function synthesizePreview(params: {
  text: string;
  voice: string;
  rate: string;
  volume: string;
  pitch: string;
  outputFormat: string;
}): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  try {
    const { EdgeTTS } = await import('@andresaya/edge-tts');
    const tts = new EdgeTTS();

    await tts.synthesize(params.text, params.voice, {
      rate: params.rate,
      volume: params.volume,
      pitch: params.pitch,
      outputFormat: params.outputFormat,
    });

    const audioBuffer = await tts.toBuffer();
    const ext = getExtFromFormat(params.outputFormat);
    const fileName = `preview_${randomUUID().substring(0, 8)}.${ext}`;
    const filePath = join(getGeneratedAudioDir(), fileName);

    writeFileSync(filePath, audioBuffer);
    console.log(`[edge-tts] Preview generated: ${fileName}`);
    return { success: true, filePath };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[edge-tts] Preview error:`, errMsg);
    return { success: false, error: errMsg };
  }
}

// ============= MCP Server =============

function createEdgeTtsServer() {
  return createSdkMcpServer({
    name: 'edge-tts',
    version: '1.0.0',
    tools: [
      tool(
        'text_to_speech',
        `Convert text to speech audio using Microsoft Edge's free TTS service.

Use this tool when the user asks you to:
- Read text aloud or generate speech/audio
- Create an audio/voice file from text
- Produce a voiceover, narration, or podcast segment
- "把这段话读出来" / "帮我生成语音"

Supports 400+ neural voices across 100+ languages. No API key needed.

Common voices:
- Chinese female: zh-CN-XiaoxiaoNeural (sweet), zh-CN-XiaomoNeural (gentle)
- Chinese male: zh-CN-YunxiNeural (narrative), zh-CN-YunjianNeural (news anchor)
- English female: en-US-JennyNeural, en-US-AriaNeural
- English male: en-US-GuyNeural, en-US-ChristopherNeural
- Japanese: ja-JP-NanamiNeural (female), ja-JP-KeitaNeural (male)

Use list_voices to discover voices for other languages.`,
        {
          text: z.string().describe('The text to convert to speech. Supports any language. For best results, use plain text without markdown.'),
          voice: z.string().optional().describe("Voice ID, e.g. 'zh-CN-XiaoxiaoNeural'. Use list_voices to find voices for a specific language. If omitted, uses the user's configured default voice."),
          rate: z.string().optional().describe("Speech rate. '+50%' = faster, '-30%' = slower, '0%' = normal. Range: -100% to +200%."),
          volume: z.string().optional().describe("Volume. '+0%' = normal, '-50%' = quieter. Range: -100% to +100%."),
          pitch: z.string().optional().describe("Voice pitch. '+10Hz' = higher, '-10Hz' = lower, '+0Hz' = normal. Range: -100Hz to +100Hz."),
        },
        textToSpeechHandler
      ),
      tool(
        'list_voices',
        `List available TTS voices. Use this to find the right voice for a specific language or gender before calling text_to_speech. Returns voice names (ShortName) that can be directly used as the "voice" parameter.`,
        {
          language: z.string().optional().describe("Filter by language code: 'zh' (all Chinese), 'zh-CN' (Mandarin), 'en' (all English), 'en-US', 'ja', 'ko', 'fr', etc."),
          gender: z.string().optional().describe("Filter by gender: 'Male' or 'Female'."),
        },
        listVoicesHandler
      ),
    ],
  });
}

export const edgeTtsServer = createEdgeTtsServer();

// ============= Builtin MCP Registry =============

import { registerBuiltinMcp } from './builtin-mcp-registry';

registerBuiltinMcp('edge-tts', {
  server: edgeTtsServer,

  configure: (env) => {
    setEdgeTtsConfig({
      defaultVoice: env.EDGE_TTS_DEFAULT_VOICE || 'zh-CN-XiaoxiaoNeural',
      defaultRate: env.EDGE_TTS_DEFAULT_RATE || '0%',
      defaultVolume: env.EDGE_TTS_DEFAULT_VOLUME || '0%',
      defaultPitch: env.EDGE_TTS_DEFAULT_PITCH || '+0Hz',
      defaultOutputFormat: env.EDGE_TTS_DEFAULT_FORMAT || 'audio-24khz-48kbitrate-mono-mp3',
    });
  },

  // Free service, no validation needed
});

// OpenClaw plugin-sdk shim for MyAgents
export function emptyPluginConfigSchema() {
  return { type: "object", properties: {}, additionalProperties: false };
}

export function applyAccountNameToChannelSection(config, section, name) {
  if (!config) config = {};
  if (!config[section]) config[section] = {};
  config[section].name = name;
  return config;
}

export function deleteAccountFromConfigSection(config, section) {
  if (config && config[section]) {
    delete config[section];
  }
  return config || {};
}

export function setAccountEnabledInConfigSection(config, section, enabled) {
  if (!config) config = {};
  if (!config[section]) config[section] = {};
  config[section].enabled = enabled;
  return config;
}

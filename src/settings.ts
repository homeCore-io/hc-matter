// The plugin's settings as a form: a JSON Schema of [matter], and the
// descriptor the app draws (core/crates/hc-types/src/config_descriptor.rs has
// the format). The defaults here are config.ts's; tests/settings.test.ts
// checks every setting config.ts reads is in the form, or left out on purpose.

/** Settings read from [matter] that the form leaves out, and why. */
export const NOT_IN_FORM: Record<string, string> = {
  // Moving it leaves the fabric behind: every device would need pairing again.
  storage_dir: "moving it orphans every paired device",
};

export const CONFIG_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "hc-matter",
  type: "object",
  properties: {
    matter: {
      type: "object",
      properties: {
        fabric_label: { type: "string", minLength: 1, maxLength: 32, default: "homeCore" },
        log_level: { type: "string", enum: ["debug", "info", "warn", "error"], default: "info" },
        primary_interface: { type: "string", default: "" },
        allow_test_devices: { type: "boolean", default: false },
        dcl_offline: { type: "boolean", default: false },
        thread_diagnostics: { type: "boolean", default: true },
        firmware_updates: { type: "boolean", default: true },
        storage_dir: { type: "string", default: "" },
      },
    },
  },
};

export const CONFIG_DESCRIPTOR = {
  plugin_id: "plugin.matter",
  descriptor_version: 1,
  title: "Matter",
  sections: [
    {
      id: "controller",
      title: "Controller",
      fields: [
        {
          key: "matter.fabric_label", kind: "text", label: "Name in other apps", default: "homeCore",
          help: "How homeCore appears in other apps' lists of what a device is paired with. Up to 32 characters.",
        },
        {
          key: "matter.firmware_updates", kind: "toggle", label: "Firmware updates", default: true,
          help: "Check for newer firmware for paired devices twice a day, and offer to install it.",
        },
        {
          key: "matter.thread_diagnostics", kind: "toggle", label: "Thread diagnostics", default: true,
          help: "Find Thread border routers on the network and read their diagnostics.",
        },
      ],
    },
    {
      id: "network",
      title: "Network",
      fields: [
        {
          key: "matter.primary_interface", kind: "text", label: "Network interface", default: "", placeholder: "eth0",
          help: "Only when the host has several: the one on the same network as your Matter devices. Empty chooses for you.",
        },
        {
          key: "matter.dcl_offline", kind: "toggle", label: "Certificates offline", default: false,
          help: "Never look device certificates up online; use only those bundled and already stored.",
        },
      ],
    },
    {
      id: "advanced",
      title: "Advanced",
      fields: [
        {
          key: "matter.allow_test_devices", kind: "toggle", label: "Allow test devices", default: false,
          help: "Accept devices with Matter's test certificates: development kits and stand-ins. A product sold as Matter certified never needs this.",
        },
        {
          key: "matter.log_level", kind: "enum", label: "Matter server log", default: "info", render: "segmented",
          help: "How much the Matter server itself logs.",
          options: [
            { value: "debug", label: "Debug" }, { value: "info", label: "Info" },
            { value: "warn", label: "Warnings" }, { value: "error", label: "Errors" },
          ],
        },
      ],
    },
  ],
};

import { definePlugin, type PluginApi } from "@hitchhiker/plugin-sdk";

let api: PluginApi;
let value = 0;
definePlugin({
  async activate(host) {
    api = host;
    await api.services.publish("counter", { value });
  },
  services: {
    async counter(method) {
      if (method !== "increment") throw new Error("Unknown counter command");
      value += 1;
      await api.services.publish("counter", { value });
      return { value };
    },
  },
});

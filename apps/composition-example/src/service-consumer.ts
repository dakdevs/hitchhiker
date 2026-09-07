import { definePlugin } from "@hitchhiker/plugin-sdk";

definePlugin({
  async activate(api) {
    const initial = await api.services.subscribe("counter");
    const result = await api.services.call("counter", "increment", null);
    await api.services.publish("report", { initial, result });
  },
});

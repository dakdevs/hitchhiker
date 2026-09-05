const std = @import("std");
const native_sdk = @import("native_sdk");
var pending_navigation: bool = false;
pub export fn hitchhiker_take_navigation() c_int {
    const pending = pending_navigation;
    pending_navigation = false;
    return if (pending) 1 else 0;
}
pub const Model = struct { loaded: bool = false };
pub const Msg = union(enum) { navigate, loaded };
const App = native_sdk.UiApp(Model, Msg);
pub fn initModel() Model {
    return .{};
}
pub fn mobileOptions() App.Options {
    return .{ .name = "Hitchhiker host probe", .scene = native_sdk.embed.mobile_shell_scene, .canvas_label = native_sdk.embed.mobile_gpu_surface_label, .update = update, .view = view, .on_command = onCommand };
}
fn onCommand(name: []const u8) ?Msg {
    if (std.mem.eql(u8, name, "page.loaded")) return .loaded;
    return null;
}
fn update(model: *Model, msg: Msg) void {
    switch (msg) {
        .navigate => {
            pending_navigation = true;
            model.loaded = false;
        },
        .loaded => model.loaded = true,
    }
}
fn view(ui: *App.Ui, model: *const Model) App.Ui.Node {
    return ui.column(.{ .gap = 16, .padding = 20 }, .{
        ui.text(.{}, "Hitchhiker"),
        ui.text(.{}, "Native UI / Chromium page"),
        ui.button(.{ .variant = .primary, .on_press = .navigate }, "Open local fixture"),
        ui.text(.{}, if (model.loaded) "Page loaded" else "Ready"),
        ui.text(.{}, "Integration experiment"),
    });
}

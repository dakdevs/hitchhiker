const std = @import("std");
const native_sdk = @import("native_sdk");
// This embedding experiment has one Native root. Commands are drained synchronously on its UI thread.
var commands: [32]c_int = undefined;
var command_read: usize = 0;
var command_count: usize = 0;
fn enqueue(command: c_int) void {
    if (command_count == commands.len) return;
    commands[(command_read + command_count) % commands.len] = command;
    command_count += 1;
}
pub export fn hitchhiker_next_command() c_int {
    if (command_count == 0) return 0;
    const command = commands[command_read];
    command_read = (command_read + 1) % commands.len;
    command_count -= 1;
    return command;
}
pub const Model = struct { one_ready: bool = false, two_ready: bool = false, layout: Layout = .one };
const Layout = enum { one, two, split };
pub const Msg = union(enum) { show_one, show_two, split, one_ready, two_ready, layout_one, layout_two, layout_split };
const App = native_sdk.UiApp(Model, Msg);
pub fn initModel() Model {
    return .{};
}
pub fn mobileOptions() App.Options {
    return .{ .name = "Hitchhiker host probe", .scene = native_sdk.embed.mobile_shell_scene, .canvas_label = native_sdk.embed.mobile_gpu_surface_label, .update = update, .view = view, .on_command = onCommand };
}
fn onCommand(name: []const u8) ?Msg {
    if (std.mem.eql(u8, name, "one.ready")) return .one_ready;
    if (std.mem.eql(u8, name, "two.ready")) return .two_ready;
    if (std.mem.eql(u8, name, "layout.one")) return .layout_one;
    if (std.mem.eql(u8, name, "layout.two")) return .layout_two;
    if (std.mem.eql(u8, name, "layout.split")) return .layout_split;
    return null;
}
fn update(model: *Model, msg: Msg) void {
    switch (msg) {
        .show_one => enqueue(1),
        .show_two => enqueue(2),
        .split => enqueue(3),
        .one_ready => model.one_ready = true,
        .two_ready => model.two_ready = true,
        .layout_one => model.layout = .one,
        .layout_two => model.layout = .two,
        .layout_split => model.layout = .split,
    }
}
fn view(ui: *App.Ui, model: *const Model) App.Ui.Node {
    return ui.column(.{ .gap = 16, .padding = 20 }, .{
        ui.text(.{}, "Hitchhiker"),
        ui.text(.{}, "Pages, any way you want"),
        ui.button(.{ .on_press = .show_one }, "Page one"),
        ui.button(.{ .on_press = .show_two }, "Page two"),
        ui.button(.{ .variant = .primary, .on_press = .split }, "Split pages"),
        ui.text(.{}, switch (model.layout) {
            .one => "Viewing page one",
            .two => "Viewing page two",
            .split => "Viewing both pages",
        }),
        ui.text(.{}, if (model.one_ready) "One: ready" else "One: loading"),
        ui.text(.{}, if (model.two_ready) "Two: ready" else "Two: loading"),
        ui.text(.{}, "Host integration experiment"),
    });
}

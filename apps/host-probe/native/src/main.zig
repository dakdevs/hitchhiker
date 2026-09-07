const std = @import("std");
const native_sdk = @import("native_sdk");
const runtime_surface = @import("runtime_surface.zig");

extern fn native_sdk_app_command(app: ?*anyopaque, name: ?[*]const u8, name_len: usize) callconv(.c) void;

const lucide_icons = blk: {
    var icons: [runtime_surface.lucide_icon_names.len]native_sdk.canvas.icons.Icon = undefined;
    for (runtime_surface.lucide_icon_names, 0..) |name, index| {
        icons[index] = native_sdk.canvas.svg_icon.parseComptime(@embedFile("icons/" ++ name ++ ".svg"));
    }
    const registered = icons;
    break :blk registered;
};

pub const app_icons = blk: {
    var entries: [runtime_surface.lucide_icon_names.len]native_sdk.canvas.icons.Entry = undefined;
    for (runtime_surface.lucide_icon_names, 0..) |name, index| {
        entries[index] = .{ .name = "lucide-" ++ name, .icon = &lucide_icons[index] };
    }
    const registered = entries;
    break :blk registered;
};

fn registerIcons() void {
    native_sdk.canvas.icons.registerAppIcons(&app_icons);
}

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
pub export fn hitchhiker_commit_tree(app: ?*anyopaque, bytes: ?[*]const u8, len: usize, revision: u64) c_int {
    if (app == null or bytes == null) return 0;
    if (!runtime_surface.commit(bytes.?[0..len], revision)) return 0;
    const refresh = "ui.runtime.updated";
    native_sdk_app_command(app, refresh.ptr, refresh.len);
    return 1;
}

pub export fn hitchhiker_next_event(buffer: ?[*]u8, capacity: usize) usize {
    return runtime_surface.nextEvent(buffer, capacity);
}

pub export fn hitchhiker_sync_viewports(app: ?*anyopaque) usize {
    return runtime_surface.syncViewports(app);
}
pub export fn hitchhiker_drag_regions(app: ?*anyopaque, buffer: ?[*]runtime_surface.DragRegion, capacity: usize) usize {
    return runtime_surface.dragRegions(app, buffer, capacity);
}

pub export fn hitchhiker_after_frame() void {
    runtime_surface.afterFrame();
}

pub const Model = struct {
    one_ready: bool = false,
    two_ready: bool = false,
    layout: Layout = .one,
    runtime_active: bool = false,
    runtime_revision: u64 = 0,
};
const Layout = enum { one, two, split };
pub const Msg = runtime_surface.Msg;
const App = native_sdk.UiApp(Model, Msg);
pub fn initModel() Model {
    registerIcons();
    runtime_surface.reset();
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
    if (std.mem.eql(u8, name, "ui.runtime.updated")) return .runtime_refresh;
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
        .runtime_refresh => {
            model.runtime_active = runtime_surface.hasTree();
            model.runtime_revision = runtime_surface.revision();
        },
        .runtime_press => |message| runtime_surface.handlePress(message),
        .runtime_input => |message| runtime_surface.handleInput(message),
    }
}
fn view(ui: *App.Ui, model: *const Model) App.Ui.Node {
    if (model.runtime_active and runtime_surface.hasTree()) return runtime_surface.build(ui);
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

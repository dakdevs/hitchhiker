const std = @import("std");
const native_sdk = @import("native_sdk");

pub const max_nodes: usize = 250;
pub const max_depth: usize = 12;
pub const max_children: usize = 100;
pub const max_tree_bytes: usize = 1024 * 1024;
const max_event_bytes: usize = 32 * 1024;
const max_events: usize = 32;

/// The exact checked-in lucide-static@1.41.0 vocabulary. Protocol icon
/// values use the Native app namespace: `app:lucide-<name>`.
pub const lucide_icon_names = [_][]const u8{
    "arrow-left",
    "arrow-right",
    "check",
    "chevron-down",
    "command",
    "download",
    "ellipsis",
    "external-link",
    "globe",
    "history",
    "layout-grid",
    "moon",
    "panel-left",
    "panel-top",
    "pin",
    "plus",
    "puzzle",
    "rotate-cw",
    "search",
    "settings",
    "shield",
    "sun",
    "x",
};

pub const InputMessage = struct {
    revision: u64,
    slot: u16,
    edit: native_sdk.canvas.TextInputEvent,
};

pub const PressMessage = struct {
    revision: u64,
    slot: u16,
};

pub const Msg = union(enum) {
    show_one,
    show_two,
    split,
    one_ready,
    two_ready,
    layout_one,
    layout_two,
    layout_split,
    runtime_refresh,
    runtime_press: PressMessage,
    runtime_input: InputMessage,
};

pub const Ui = native_sdk.canvas.Ui(Msg);

const Kind = enum {
    row,
    column,
    stack,
    text,
    button,
    input,
    scroll,
    spacer,
    icon,
    viewport,
};

/// Protocol strings are intentionally wrapped instead of using `[]const u8`
/// directly. Zig's generic JSON slice decoder also accepts arrays of numeric
/// bytes and instantiates its integer coercion path, which pulls quad-float
/// compiler runtime symbols into this otherwise self-contained static library.
/// Hitchhiker's wire format accepts JSON strings only.
const WireString = struct {
    value: []const u8,

    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !WireString {
        const token = try source.nextAllocMax(allocator, .alloc_if_needed, options.max_value_len.?);
        return switch (token) {
            .string => |bytes| .{ .value = try allocator.dupe(u8, bytes) },
            .allocated_string => |bytes| blk: {
                defer allocator.free(bytes);
                break :blk .{ .value = try allocator.dupe(u8, bytes) };
            },
            else => error.UnexpectedToken,
        };
    }
};

/// A JSON number parser limited to the ordinary finite decimal notation
/// used by layout styles. Zig's general `parseFloat` intentionally handles
/// much wider IEEE cases through quad-float compiler helpers; those helpers
/// are not part of the CEF host's C++ link. This parser keeps the static
/// embed archive self-contained while still accepting fractions/exponents.
const WireNumber = struct {
    value: f32,

    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !WireNumber {
        const token = try source.nextAllocMax(allocator, .alloc_if_needed, options.max_value_len.?);
        defer switch (token) {
            .allocated_number => |bytes| allocator.free(bytes),
            else => {},
        };
        const bytes = switch (token) {
            inline .number, .allocated_number => |value| value,
            else => return error.UnexpectedToken,
        };
        return .{ .value = try parseDecimal(bytes) };
    }
};

fn parseDecimal(bytes: []const u8) !f32 {
    if (bytes.len == 0) return error.InvalidNumber;
    var index: usize = 0;
    var negative = false;
    if (bytes[index] == '-') {
        negative = true;
        index += 1;
        if (index == bytes.len) return error.InvalidNumber;
    }

    var value: f64 = 0;
    var integer_digits: usize = 0;
    while (index < bytes.len and bytes[index] >= '0' and bytes[index] <= '9') : (index += 1) {
        value = value * 10 + @as(f64, @floatFromInt(bytes[index] - '0'));
        integer_digits += 1;
    }
    if (integer_digits == 0) return error.InvalidNumber;

    if (index < bytes.len and bytes[index] == '.') {
        index += 1;
        var scale: f64 = 0.1;
        var fraction_digits: usize = 0;
        while (index < bytes.len and bytes[index] >= '0' and bytes[index] <= '9') : (index += 1) {
            value += @as(f64, @floatFromInt(bytes[index] - '0')) * scale;
            scale *= 0.1;
            fraction_digits += 1;
        }
        if (fraction_digits == 0) return error.InvalidNumber;
    }

    var exponent: i32 = 0;
    if (index < bytes.len and (bytes[index] == 'e' or bytes[index] == 'E')) {
        index += 1;
        var exponent_negative = false;
        if (index < bytes.len and (bytes[index] == '+' or bytes[index] == '-')) {
            exponent_negative = bytes[index] == '-';
            index += 1;
        }
        var exponent_digits: usize = 0;
        while (index < bytes.len and bytes[index] >= '0' and bytes[index] <= '9') : (index += 1) {
            if (exponent > 64) return error.InvalidNumber;
            exponent = exponent * 10 + @as(i32, bytes[index] - '0');
            exponent_digits += 1;
        }
        if (exponent_digits == 0 or exponent > 64) return error.InvalidNumber;
        if (exponent_negative) exponent = -exponent;
    }
    if (index != bytes.len) return error.InvalidNumber;

    if (exponent > 0) {
        for (0..@intCast(exponent)) |_| value *= 10;
    } else if (exponent < 0) {
        for (0..@intCast(-exponent)) |_| value /= 10;
    }
    if (negative) value = -value;
    return @floatCast(value);
}

const WireNode = struct {
    key: WireString,
    kind: Kind,
    label: ?WireString = null,
    value: ?WireString = null,
    action: ?WireString = null,
    placeholder: ?WireString = null,
    icon: ?WireString = null,
    viewportId: ?WireString = null,
    children: []const WireNode = &.{},
    width: ?WireNumber = null,
    height: ?WireNumber = null,
    flex: ?WireNumber = null,
    padding: ?WireNumber = null,
    gap: ?WireNumber = null,
    bg: ?WireString = null,
    fg: ?WireString = null,
    radius: ?WireNumber = null,
    fontSize: ?WireNumber = null,
};

const ValidationError = error{
    InvalidKey,
    DuplicateKey,
    TooDeep,
    TooManyNodes,
    TooManyChildren,
    InvalidChildren,
    InvalidString,
    InvalidNumber,
    InvalidColor,
    InvalidIcon,
    InvalidViewport,
};

const EventSlot = struct {
    len: usize = 0,
    bytes: [max_event_bytes]u8 = undefined,
};

const ViewportRect = struct {
    valid: bool = false,
    revision: u64 = 0,
    x: f32 = 0,
    y: f32 = 0,
    width: f32 = 0,
    height: f32 = 0,
};

var active_tree: ?std.json.Parsed(WireNode) = null;
// Native's UiApp keeps the prior source generation alive through its
// two-arena rebuild/frame swap. Its retained widget snapshot deep-copies
// strings, but releasing this parsed tree before that swap completes makes
// the old source nodes dangle during reconciliation.
var retired_tree: ?std.json.Parsed(WireNode) = null;
var active_revision: u64 = 0;
var active_node_count: usize = 0;
var active_nodes: [max_nodes]?*const WireNode = [_]?*const WireNode{null} ** max_nodes;
var viewport_rects: [max_nodes]ViewportRect = [_]ViewportRect{.{}} ** max_nodes;
var events: [max_events]EventSlot = undefined;
var event_read: usize = 0;
var event_count: usize = 0;

extern fn native_sdk_app_widget_semantics_by_id(app: ?*anyopaque, id: u64, out: ?*native_sdk.embed.MobileWidgetSemantics) callconv(.c) c_int;

pub fn reset() void {
    if (active_tree) |*tree| tree.deinit();
    if (retired_tree) |*tree| tree.deinit();
    active_tree = null;
    retired_tree = null;
    active_revision = 0;
    active_node_count = 0;
    active_nodes = [_]?*const WireNode{null} ** max_nodes;
    viewport_rects = [_]ViewportRect{.{}} ** max_nodes;
    event_read = 0;
    event_count = 0;
}

pub fn hasTree() bool {
    return active_tree != null;
}

pub fn revision() u64 {
    return active_revision;
}

pub fn commit(root_json: []const u8, next_revision: u64) bool {
    if (next_revision == 0 or next_revision <= active_revision) {
        enqueueError(next_revision, "stale_revision");
        return false;
    }
    if (root_json.len == 0 or root_json.len > max_tree_bytes) {
        enqueueError(next_revision, "tree_size");
        return false;
    }

    var parsed = std.json.parseFromSlice(WireNode, std.heap.page_allocator, root_json, .{
        .ignore_unknown_fields = false,
    }) catch {
        enqueueError(next_revision, "invalid_json");
        return false;
    };
    var seen: [max_nodes][]const u8 = undefined;
    var count: usize = 0;
    validateNode(&parsed.value, 0, &count, &seen) catch |err| {
        parsed.deinit();
        enqueueError(next_revision, validationCode(err));
        return false;
    };

    // The host releases a retired generation after the Native frame that
    // follows every accepted commit. Refuse an unexpected overlapping commit
    // instead of freeing memory Native may still be reconciling against.
    if (retired_tree != null) {
        parsed.deinit();
        enqueueError(next_revision, "frame_pending");
        return false;
    }

    retired_tree = active_tree;
    active_tree = null;
    active_tree = parsed;
    active_revision = next_revision;
    active_node_count = 0;
    active_nodes = [_]?*const WireNode{null} ** max_nodes;
    indexNodes(&active_tree.?.value);
    viewport_rects = [_]ViewportRect{.{}} ** max_nodes;
    return true;
}

/// Called by the AppKit host immediately after `native_sdk_app_frame`.
/// By this point the successful rebuild's retained widget snapshot owns its
/// strings and UiApp has completed the old/new arena swap.
pub fn afterFrame() void {
    if (retired_tree) |*tree| tree.deinit();
    retired_tree = null;
}

fn validationCode(err: ValidationError) []const u8 {
    return switch (err) {
        error.InvalidKey => "invalid_key",
        error.DuplicateKey => "duplicate_key",
        error.TooDeep => "tree_depth",
        error.TooManyNodes => "node_count",
        error.TooManyChildren => "child_count",
        error.InvalidChildren => "invalid_children",
        error.InvalidString => "invalid_string",
        error.InvalidNumber => "invalid_style_number",
        error.InvalidColor => "invalid_color",
        error.InvalidIcon => "invalid_icon",
        error.InvalidViewport => "invalid_viewport",
    };
}

fn validateNode(node: *const WireNode, depth: usize, count: *usize, seen: *[max_nodes][]const u8) ValidationError!void {
    if (depth > max_depth) return error.TooDeep;
    if (count.* >= max_nodes) return error.TooManyNodes;
    const key = node.key.value;
    if (key.len == 0 or key.len > 128 or !std.unicode.utf8ValidateSlice(key)) return error.InvalidKey;
    for (seen[0..count.*]) |seen_key| {
        if (std.mem.eql(u8, seen_key, node.key.value)) return error.DuplicateKey;
    }
    seen[count.*] = key;
    count.* += 1;

    if (node.children.len > max_children) return error.TooManyChildren;
    if (node.children.len != 0 and !isContainer(node.kind)) return error.InvalidChildren;
    try validateDisplayString(node.label);
    try validateDisplayString(node.value);
    try validateDisplayString(node.placeholder);
    if (node.action) |action| {
        if (action.value.len > 256 or !std.unicode.utf8ValidateSlice(action.value)) return error.InvalidString;
    }
    if (node.icon) |icon| {
        if (!isLucideProtocolIcon(icon.value)) return error.InvalidIcon;
    }
    if (node.kind == .icon and node.icon == null) return error.InvalidIcon;
    if (node.kind == .viewport) {
        const viewport_id = (node.viewportId orelse return error.InvalidViewport).value;
        if (viewport_id.len == 0 or viewport_id.len > 128 or !std.unicode.utf8ValidateSlice(viewport_id)) return error.InvalidViewport;
    } else if (node.viewportId != null) {
        return error.InvalidViewport;
    }
    try validateNumber(node.width, 8192);
    try validateNumber(node.height, 8192);
    try validateNumber(node.flex, 100);
    try validateNumber(node.padding, 256);
    try validateNumber(node.gap, 256);
    try validateNumber(node.radius, 256);
    if (numberValue(node.fontSize)) |size| {
        if (!std.math.isFinite(size) or size < 8 or size > 64) return error.InvalidNumber;
    }
    if (node.bg) |color| _ = parseColor(color.value) catch return error.InvalidColor;
    if (node.fg) |color| _ = parseColor(color.value) catch return error.InvalidColor;

    for (node.children) |*child| try validateNode(child, depth + 1, count, seen);
}

fn isLucideProtocolIcon(icon: []const u8) bool {
    const prefix = "app:lucide-";
    if (!std.mem.startsWith(u8, icon, prefix)) return false;
    const name = icon[prefix.len..];
    for (lucide_icon_names) |known| {
        if (std.mem.eql(u8, name, known)) return true;
    }
    return false;
}

fn isContainer(kind: Kind) bool {
    return switch (kind) {
        .row, .column, .stack, .scroll => true,
        else => false,
    };
}

fn validateDisplayString(value: ?WireString) ValidationError!void {
    if (value) |text| {
        if (text.value.len > 4000 or !std.unicode.utf8ValidateSlice(text.value)) return error.InvalidString;
    }
}

fn stringValue(value: ?WireString) ?[]const u8 {
    return if (value) |text| text.value else null;
}

fn validateNumber(value: ?WireNumber, max: f32) ValidationError!void {
    if (numberValue(value)) |number| {
        if (!std.math.isFinite(number) or number < 0 or number > max) return error.InvalidNumber;
    }
}

fn numberValue(value: ?WireNumber) ?f32 {
    return if (value) |number| number.value else null;
}

fn indexNodes(node: *const WireNode) void {
    if (active_node_count >= max_nodes) return;
    active_nodes[active_node_count] = node;
    active_node_count += 1;
    for (node.children) |*child| indexNodes(child);
}

pub fn build(ui: *Ui) Ui.Node {
    const tree = active_tree orelse return ui.text(.{}, "Runtime interface unavailable");
    var slot: usize = 0;
    return buildNode(ui, &tree.value, &slot);
}

fn buildNode(ui: *Ui, node: *const WireNode, slot: *usize) Ui.Node {
    const node_slot = slot.*;
    slot.* += 1;
    var options = optionsFor(node);
    var children = ui.arena.alloc(Ui.Node, node.children.len) catch
        return ui.text(.{}, "Runtime interface exceeded Native memory limits");
    for (node.children, 0..) |*child, index| children[index] = buildNode(ui, child, slot);

    return switch (node.kind) {
        .row => ui.row(options, children),
        .column => ui.column(options, children),
        .stack => ui.stack(options, children),
        .scroll => ui.scroll(options, children),
        .text => ui.text(options, stringValue(node.label) orelse stringValue(node.value) orelse ""),
        .button => blk: {
            if (node.action != null) options.on_press = .{ .runtime_press = .{
                .revision = active_revision,
                .slot = @intCast(node_slot),
            } };
            break :blk ui.button(options, stringValue(node.label) orelse "");
        },
        .input => blk: {
            options.text = stringValue(node.value) orelse "";
            options.on_input = input_thunks[node_slot];
            if (node.action != null) options.on_submit = .{ .runtime_press = .{
                .revision = active_revision,
                .slot = @intCast(node_slot),
            } };
            break :blk ui.textField(options);
        },
        .spacer => ui.spacer(numberValue(node.flex) orelse 1),
        .icon => ui.appIcon(options, node.icon.?.value),
        // A viewport is an empty Native layout/semantics node. The trusted
        // browser host positions the corresponding CEF page from the
        // emitted semantics bounds; plugin data never supplies CEF rects.
        .viewport => ui.stack(options, .{}),
    };
}

fn optionsFor(node: *const WireNode) Ui.ElementOptions {
    const transparent = native_sdk.canvas.Color.rgba8(0, 0, 0, 0);
    var style: native_sdk.canvas.WidgetStyle = .{};
    if (node.bg) |color| style.background = parseColor(color.value) catch null;
    if (node.fg) |color| style.foreground = parseColor(color.value) catch null;
    if (numberValue(node.radius)) |radius| style.radius = radius;
    if (node.kind == .viewport and node.bg == null) style.background = transparent;

    return .{
        .global_key = native_sdk.canvas.uiKey(node.key.value),
        .width = numberValue(node.width) orelse 0,
        .height = numberValue(node.height) orelse 0,
        .grow = numberValue(node.flex) orelse if (node.kind == .viewport) 1 else 0,
        .padding = numberValue(node.padding),
        .gap = numberValue(node.gap) orelse 0,
        .placeholder = stringValue(node.placeholder) orelse "",
        .icon = stringValue(node.icon) orelse "",
        .size = sizeFor(node.kind, numberValue(node.fontSize)),
        .style = style,
        .semantics = if (node.kind == .viewport)
            .{ .role = .group, .label = node.viewportId.?.value }
        else if (node.label != null and node.kind == .input)
            .{ .label = node.label.?.value }
        else
            .{},
    };
}

fn sizeFor(kind: Kind, requested: ?f32) native_sdk.canvas.WidgetSize {
    const size = requested orelse return if (kind == .icon) .icon else .default;
    if (kind == .text) {
        if (size >= 40) return .display;
        if (size >= 22) return .heading;
    }
    if (size <= 13) return .sm;
    if (size >= 18) return .lg;
    return .default;
}

fn parseColor(text: []const u8) !native_sdk.canvas.Color {
    if (text.len != 7 and text.len != 9) return error.InvalidColor;
    if (text[0] != '#') return error.InvalidColor;
    const r = std.fmt.parseInt(u8, text[1..3], 16) catch return error.InvalidColor;
    const g = std.fmt.parseInt(u8, text[3..5], 16) catch return error.InvalidColor;
    const b = std.fmt.parseInt(u8, text[5..7], 16) catch return error.InvalidColor;
    const a = if (text.len == 9)
        std.fmt.parseInt(u8, text[7..9], 16) catch return error.InvalidColor
    else
        255;
    return native_sdk.canvas.Color.rgba8(r, g, b, a);
}

fn inputThunk(comptime slot: usize) Ui.InputMsgFn {
    return struct {
        fn make(edit: native_sdk.canvas.TextInputEvent) Msg {
            return .{ .runtime_input = .{
                .revision = active_revision,
                .slot = slot,
                .edit = edit,
            } };
        }
    }.make;
}

fn makeInputThunks() [max_nodes]Ui.InputMsgFn {
    var result: [max_nodes]Ui.InputMsgFn = undefined;
    inline for (0..max_nodes) |slot| result[slot] = inputThunk(slot);
    return result;
}

const input_thunks = makeInputThunks();

pub fn handlePress(message: PressMessage) void {
    if (message.revision != active_revision) return;
    const node = nodeForSlot(message.slot) orelse return;
    const action = (node.action orelse return).value;
    var builder = beginEvent(active_revision, node.key.value, "press") orelse return;
    builder.appendLiteral("{\"action\":") catch return;
    builder.appendJsonString(action) catch return;
    builder.appendLiteral("}}") catch return;
    finishEvent(&builder);
}

pub fn handleInput(message: InputMessage) void {
    if (message.revision != active_revision) return;
    const node = nodeForSlot(message.slot) orelse return;
    if (node.kind != .input) return;
    var builder = beginEvent(active_revision, node.key.value, "input") orelse return;
    builder.appendByte('{') catch return;
    writeInputPayload(&builder, message.edit) catch return;
    builder.appendLiteral("}}") catch return;
    finishEvent(&builder);
}

fn nodeForSlot(slot: u16) ?*const WireNode {
    const index: usize = slot;
    if (index >= active_node_count) return null;
    return active_nodes[index];
}

fn writeInputPayload(builder: *EventBuilder, edit: native_sdk.canvas.TextInputEvent) !void {
    try builder.appendLiteral("\"kind\":");
    try builder.appendJsonString(@tagName(edit));
    switch (edit) {
        .insert_text => |text| {
            try builder.appendLiteral(",\"text\":");
            try builder.appendJsonString(text);
        },
        .move_caret => |move| {
            try builder.appendLiteral(",\"direction\":");
            try builder.appendJsonString(@tagName(move.direction));
            try builder.appendLiteral(",\"extend\":");
            try builder.appendLiteral(if (move.extend) "true" else "false");
        },
        .set_selection => |selection| {
            try builder.appendLiteral(",\"anchor\":");
            try builder.appendSelectionOffset(selection.anchor);
            try builder.appendLiteral(",\"focus\":");
            try builder.appendSelectionOffset(selection.focus);
            try builder.appendLiteral(",\"affinity\":");
            try builder.appendJsonString(@tagName(selection.affinity));
        },
        .set_composition => |composition| {
            try builder.appendLiteral(",\"text\":");
            try builder.appendJsonString(composition.text);
            try builder.appendLiteral(",\"cursor\":");
            if (composition.cursor) |cursor| try builder.appendUnsigned(cursor) else try builder.appendLiteral("null");
        },
        else => {},
    }
}

pub fn syncViewports(app: ?*anyopaque) usize {
    if (app == null or active_tree == null) return 0;
    var queued: usize = 0;
    for (active_nodes[0..active_node_count], 0..) |maybe_node, slot| {
        const node = maybe_node orelse continue;
        if (node.kind != .viewport) continue;
        const widget_id = native_sdk.canvas.globalWidgetId(.stack, native_sdk.canvas.uiKey(node.key.value));
        var semantics = native_sdk.embed.MobileWidgetSemantics{};
        if (native_sdk_app_widget_semantics_by_id(app, widget_id, &semantics) != 1) continue;
        const next = ViewportRect{
            .valid = true,
            .revision = active_revision,
            .x = semantics.x,
            .y = semantics.y,
            .width = semantics.width,
            .height = semantics.height,
        };
        if (sameViewport(viewport_rects[slot], next)) continue;
        viewport_rects[slot] = next;
        enqueueViewport(active_revision, node.key.value, node.viewportId.?.value, next);
        queued += 1;
    }
    return queued;
}

fn sameViewport(a: ViewportRect, b: ViewportRect) bool {
    return a.valid and a.revision == b.revision and a.x == b.x and a.y == b.y and a.width == b.width and a.height == b.height;
}

fn enqueueViewport(event_revision: u64, node_id: []const u8, viewport_id: []const u8, rect: ViewportRect) void {
    var builder = beginEvent(event_revision, node_id, "viewport") orelse return;
    builder.appendLiteral("{\"viewportId\":") catch return;
    builder.appendJsonString(viewport_id) catch return;
    builder.appendLiteral(",\"x\":") catch return;
    builder.appendFloat(rect.x) catch return;
    builder.appendLiteral(",\"y\":") catch return;
    builder.appendFloat(rect.y) catch return;
    builder.appendLiteral(",\"width\":") catch return;
    builder.appendFloat(rect.width) catch return;
    builder.appendLiteral(",\"height\":") catch return;
    builder.appendFloat(rect.height) catch return;
    builder.appendLiteral("}}") catch return;
    finishEvent(&builder);
}

fn enqueueError(event_revision: u64, code: []const u8) void {
    var builder = beginEvent(event_revision, "", "error") orelse return;
    builder.appendLiteral("{\"code\":") catch return;
    builder.appendJsonString(code) catch return;
    builder.appendLiteral("}}") catch return;
    finishEvent(&builder);
}

const EventBuilder = struct {
    slot_index: usize,
    len: usize = 0,

    fn appendByte(self: *EventBuilder, value: u8) !void {
        if (self.len >= max_event_bytes) return error.NoSpaceLeft;
        events[self.slot_index].bytes[self.len] = value;
        self.len += 1;
    }

    fn appendLiteral(self: *EventBuilder, value: []const u8) !void {
        if (value.len > max_event_bytes - self.len) return error.NoSpaceLeft;
        @memcpy(events[self.slot_index].bytes[self.len..][0..value.len], value);
        self.len += value.len;
    }

    fn appendJsonString(self: *EventBuilder, value: []const u8) !void {
        try self.appendByte('"');
        for (value) |byte| switch (byte) {
            '"' => try self.appendLiteral("\\\""),
            '\\' => try self.appendLiteral("\\\\"),
            '\n' => try self.appendLiteral("\\n"),
            '\r' => try self.appendLiteral("\\r"),
            '\t' => try self.appendLiteral("\\t"),
            0x08 => try self.appendLiteral("\\b"),
            0x0c => try self.appendLiteral("\\f"),
            0x00...0x07, 0x0b, 0x0e...0x1f => {
                try self.appendLiteral("\\u00");
                try self.appendByte(hexDigit(byte >> 4));
                try self.appendByte(hexDigit(byte & 0x0f));
            },
            else => try self.appendByte(byte),
        };
        try self.appendByte('"');
    }

    fn appendUnsigned(self: *EventBuilder, value: anytype) !void {
        var scratch: [32]u8 = undefined;
        const text = std.fmt.bufPrint(&scratch, "{d}", .{value}) catch return error.NoSpaceLeft;
        try self.appendLiteral(text);
    }

    fn appendSelectionOffset(self: *EventBuilder, value: usize) !void {
        // Native uses maxInt(usize) as "to the end". JSON numbers cannot
        // carry that value exactly through JavaScript, so the wire uses -1.
        if (value == std.math.maxInt(usize)) return self.appendLiteral("-1");
        return self.appendUnsigned(value);
    }

    fn appendFloat(self: *EventBuilder, value: f32) !void {
        var scratch: [64]u8 = undefined;
        const text = std.fmt.bufPrint(&scratch, "{d}", .{value}) catch return error.NoSpaceLeft;
        try self.appendLiteral(text);
    }
};

fn hexDigit(value: u8) u8 {
    return if (value < 10) '0' + value else 'a' + (value - 10);
}

fn beginEvent(event_revision: u64, node_id: []const u8, event_name: []const u8) ?EventBuilder {
    if (event_count == max_events) return null;
    const slot_index = (event_read + event_count) % max_events;
    var builder = EventBuilder{ .slot_index = slot_index };
    builder.appendLiteral("{\"surfaceId\":\"main\",\"revision\":") catch return null;
    builder.appendUnsigned(event_revision) catch return null;
    builder.appendLiteral(",\"nodeId\":") catch return null;
    builder.appendJsonString(node_id) catch return null;
    builder.appendLiteral(",\"event\":") catch return null;
    builder.appendJsonString(event_name) catch return null;
    builder.appendLiteral(",\"payload\":") catch return null;
    return builder;
}

fn finishEvent(builder: *const EventBuilder) void {
    events[builder.slot_index].len = builder.len;
    event_count += 1;
}

/// Returns 0 when empty. When `capacity` is too small (or `buffer` is
/// null), returns the required size without popping. Successful copies are
/// exact non-NUL JSON bytes and pop one event.
pub fn nextEvent(buffer: ?[*]u8, capacity: usize) usize {
    if (event_count == 0) return 0;
    const event = &events[event_read];
    if (buffer == null or capacity < event.len) return event.len;
    @memcpy(buffer.?[0..event.len], event.bytes[0..event.len]);
    const len = event.len;
    event_read = (event_read + 1) % max_events;
    event_count -= 1;
    return len;
}

test "runtime surface accepts a bounded keyed tree and rejects stale revisions" {
    reset();
    defer reset();
    const root =
        \\{"key":"root","kind":"column","children":[{"key":"title","kind":"text","label":"Hello"},{"key":"page","kind":"viewport","viewportId":"primary","flex":1}]}
    ;
    try std.testing.expect(commit(root, 1));
    try std.testing.expectEqual(@as(u64, 1), revision());
    try std.testing.expectEqual(@as(usize, 3), active_node_count);
    try std.testing.expect(!commit(root, 1));
    try std.testing.expectEqual(@as(u64, 1), revision());
}

test "runtime surface rejects duplicate keys without replacing last good tree" {
    reset();
    defer reset();
    try std.testing.expect(commit("{\"key\":\"root\",\"kind\":\"text\",\"label\":\"ok\"}", 1));
    try std.testing.expect(!commit("{\"key\":\"same\",\"kind\":\"row\",\"children\":[{\"key\":\"same\",\"kind\":\"text\"}]}", 2));
    try std.testing.expectEqual(@as(u64, 1), revision());
}

test "runtime surface retains one prior generation until its Native frame" {
    reset();
    defer reset();
    try std.testing.expect(commit("{\"key\":\"one\",\"kind\":\"text\",\"label\":\"one\"}", 1));
    afterFrame();
    try std.testing.expect(commit("{\"key\":\"two\",\"kind\":\"text\",\"label\":\"two\"}", 2));
    try std.testing.expect(!commit("{\"key\":\"three\",\"kind\":\"text\",\"label\":\"three\"}", 3));
    try std.testing.expectEqual(@as(u64, 2), revision());
    afterFrame();
    try std.testing.expect(commit("{\"key\":\"three\",\"kind\":\"text\",\"label\":\"three\"}", 3));
    try std.testing.expectEqual(@as(u64, 3), revision());
}

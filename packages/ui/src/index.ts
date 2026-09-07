/** Native component data. Chromium geometry is measured by the host, never supplied here. */
export interface Style {
  readonly width?: number;
  readonly height?: number;
  readonly flex?: number;
  readonly padding?: number;
  readonly gap?: number;
  readonly bg?: string;
  readonly fg?: string;
  readonly radius?: number;
  /** Selects Native typography size tokens rather than arbitrary font rasterization sizes. */
  readonly fontSize?: number;
}
export interface ButtonStyle extends Style {
  readonly icon?: IconName;
  readonly iconOnly?: boolean;
  /** Spoken label when the visual button text is abbreviated. */
  readonly accessibilityLabel?: string;
  readonly variant?: "ghost" | "secondary";
}
export interface ListItemStyle extends Style {
  readonly icon?: IconName;
}
export const lucideNames = [
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
] as const;
export type LucideName = (typeof lucideNames)[number];
export type IconName = `app:lucide-${LucideName}`;
export const lucide = (name: LucideName): IconName => `app:lucide-${name}`;
interface NodeBase extends Style {
  readonly key: string;
}
export type NativeNode = NodeBase &
  (
    | {
        readonly kind: "row" | "column" | "stack" | "scroll";
        readonly children: readonly NativeNode[];
      }
    | { readonly kind: "text"; readonly label: string }
    | {
        readonly kind: "button";
        /** Always present for native accessibility, even when the visual label is hidden. */
        readonly label: string;
        readonly action: string;
        readonly icon?: IconName;
        readonly iconOnly?: boolean;
        readonly accessibilityLabel?: string;
        readonly variant?: "ghost" | "secondary";
      }
    | {
        readonly kind: "list-item";
        readonly label: string;
        readonly action: string;
        readonly icon?: IconName;
      }
    | {
        readonly kind: "input";
        readonly label: string;
        readonly value: string;
        readonly placeholder?: string;
        readonly action?: string;
      }
    | { readonly kind: "icon"; readonly icon: IconName }
    | { readonly kind: "spacer" }
    | { readonly kind: "drag-region" }
    | { readonly kind: "viewport"; readonly viewportId: string }
  );
/** Bindings are separate from layout so interfaces can reorganize without recreating pages. */
export interface Surface {
  /** Stable interface identity. A trusted plugin host must set this from the installed plugin identity. */
  readonly identity?: string;
  readonly root: NativeNode;
  readonly bindings: readonly { readonly viewportId: string; readonly pageId: string }[];
}
const container =
  (kind: "row" | "column" | "stack" | "scroll") =>
  (key: string, children: readonly NativeNode[], style: Style = {}): NativeNode => ({
    key,
    kind,
    children,
    ...style,
  });
export const row = container("row");
export const column = container("column");
export const stack = container("stack");
export const scroll = container("scroll");
export const text = (key: string, label: string, style: Style = {}): NativeNode => ({
  key,
  kind: "text",
  label,
  ...style,
});
export const button = (
  key: string,
  label: string,
  action: string,
  style: ButtonStyle = {},
): NativeNode => {
  if (label.trim().length === 0) throw new Error("Button labels must be nonempty.");
  return { key, kind: "button", label, action, ...style };
};
/** A compact icon control whose text label remains available to accessibility APIs. */
export const iconButton = (
  key: string,
  label: string,
  action: string,
  name: LucideName,
  style: ButtonStyle = {},
): NativeNode =>
  button(key, label, action, { variant: "ghost", ...style, icon: lucide(name), iconOnly: true });
export const listItem = (
  key: string,
  label: string,
  action: string,
  style: ListItemStyle = {},
): NativeNode => {
  if (label.trim().length === 0) throw new Error("List item labels must be nonempty.");
  return { key, kind: "list-item", label, action, ...style };
};
export const input = (
  key: string,
  label: string,
  value: string,
  style: Style & { readonly placeholder?: string; readonly action?: string } = {},
): NativeNode => ({ key, kind: "input", label, value, ...style });
export const icon = (key: string, name: LucideName, style: Style = {}): NativeNode => ({
  key,
  kind: "icon",
  icon: lucide(name),
  ...style,
});
export const spacer = (key: string, flex = 1): NativeNode => ({ key, kind: "spacer", flex });
/** An empty region that the host may expose as a native window drag target. */
export const dragRegion = (key: string, style: Style = {}): NativeNode => ({
  key,
  kind: "drag-region",
  flex: 1,
  ...style,
});
/** Native window chrome dimensions shared by replaceable interface surfaces. */
export const windowChrome = Object.freeze({ height: 36, controlsWidth: 80 });
/** Reserves the native system-window-controls area without drawing replacement controls. */
export const windowControls = (key: string): NativeNode =>
  column(key, [], { width: windowChrome.controlsWidth, height: windowChrome.height });
export const viewport = (key: string, viewportId: string, style: Style = {}): NativeNode => ({
  key,
  kind: "viewport",
  viewportId,
  ...style,
});

export const design = Object.freeze({
  light: Object.freeze({
    canvas: "#FFFFFF",
    sidebar: "#EEEEEF",
    foreground: "#171717",
    muted: "#6B6B6B",
    selected: "#FFFFFF",
  }),
  dark: Object.freeze({
    canvas: "#212121",
    sidebar: "#171717",
    foreground: "#ECECEC",
    muted: "#B4B4B4",
    selected: "#303030",
  }),
  radius: Object.freeze({ control: 8, panel: 12 }),
  spacing: Object.freeze({ compact: 4, control: 8, panel: 12, section: 20 }),
  /** Shared motion contract; host support is required before these can animate a surface. */
  motion: Object.freeze({ quickMs: 120, standardMs: 180, enterMs: 220, reducedMs: 0 }),
});
export * from "./text-input.js";

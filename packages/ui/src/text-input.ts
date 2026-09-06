/**
 * The Native canvas text-input wire reducer. Offsets are UTF-8 byte offsets,
 * never JavaScript UTF-16 indexes. A selection offset of -1 is the Native
 * wire sentinel for the end of the text.
 */
export const nativeTextInputLimit = 4 * 1024;

export type NativeCaretDirection =
  | "previous"
  | "next"
  | "previous_word"
  | "next_word"
  | "start"
  | "end";

export type NativeTextInputEvent =
  | { readonly kind: "insert_text"; readonly text: string }
  | {
      readonly kind:
        | "delete_backward"
        | "delete_forward"
        | "delete_word_backward"
        | "delete_word_forward"
        | "delete_to_start"
        | "delete_to_line_start"
        | "clear"
        | "commit_composition"
        | "cancel_composition";
    }
  | {
      readonly kind: "move_caret";
      readonly direction: NativeCaretDirection;
      readonly extend: boolean;
    }
  | {
      readonly kind: "set_selection";
      readonly anchor: number;
      readonly focus: number;
      readonly affinity: "upstream" | "downstream";
    }
  | { readonly kind: "set_composition"; readonly text: string; readonly cursor: number | null };

export interface NativeTextComposition {
  readonly start: number;
  readonly end: number;
}

export interface NativeTextInputState {
  readonly text: string;
  readonly anchor: number;
  readonly focus: number;
  readonly composition: NativeTextComposition | null;
}

interface Scalar {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

// JavaScriptCore plugins have ECMAScript builtins, not the DOM TextEncoder API.
const byteLength = (text: string) => {
  let length = 0;
  for (const scalar of text) {
    const point = scalar.codePointAt(0)!;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
};

const scalars = (text: string): readonly Scalar[] => {
  const result: Scalar[] = [];
  let offset = 0;
  for (const scalar of text) {
    const length = byteLength(scalar);
    result.push({ start: offset, end: offset + length, text: scalar });
    offset += length;
  }
  return result;
};

const prefixForBytes = (text: string, maximum: number) => {
  let total = 0;
  let prefix = "";
  for (const scalar of text) {
    const size = byteLength(scalar);
    if (total + size > maximum) break;
    prefix += scalar;
    total += size;
  }
  return prefix;
};

const normalizeOffset = (text: string, offset: number, endSentinel = false) => {
  const length = byteLength(text);
  if (endSentinel && offset === -1) return length;
  if (!Number.isFinite(offset)) return 0;
  const target = Math.max(0, Math.min(length, Math.trunc(offset)));
  let snapped = 0;
  for (const scalar of scalars(text)) {
    if (scalar.end > target) break;
    snapped = scalar.end;
  }
  return snapped;
};

const normalizeState = (state: NativeTextInputState): NativeTextInputState => {
  const text = prefixForBytes(state.text, nativeTextInputLimit);
  const anchor = normalizeOffset(text, state.anchor);
  const focus = normalizeOffset(text, state.focus);
  const composition =
    state.composition === null ? null : range(text, state.composition.start, state.composition.end);
  return { text, anchor, focus, composition };
};

const range = (text: string, start: number, end: number): NativeTextComposition => {
  const left = normalizeOffset(text, start);
  const right = normalizeOffset(text, end);
  return left <= right ? { start: left, end: right } : { start: right, end: left };
};

const selectedRange = (state: NativeTextInputState) => range(state.text, state.anchor, state.focus);
const activeRange = (state: NativeTextInputState) => state.composition ?? selectedRange(state);

const splitAt = (text: string, offset: number) => {
  const boundary = normalizeOffset(text, offset);
  let index = 0;
  for (const scalar of text) {
    if (byteLength(text.slice(0, index + scalar.length)) > boundary) break;
    index += scalar.length;
  }
  return [text.slice(0, index), text.slice(index)] as const;
};

const replace = (
  state: NativeTextInputState,
  replacement: string,
  composition: NativeTextComposition | null,
  cursor: number,
): NativeTextInputState => {
  const target = activeRange(state);
  const [prefix] = splitAt(state.text, target.start);
  const [, suffix] = splitAt(state.text, target.end);
  const inserted = prefixForBytes(
    replacement,
    Math.max(0, nativeTextInputLimit - byteLength(prefix) - byteLength(suffix)),
  );
  const text = prefix + inserted + suffix;
  const cursorOffset = normalizeOffset(inserted, cursor);
  const absoluteCursor = byteLength(prefix) + cursorOffset;
  return {
    text,
    anchor: absoluteCursor,
    focus: absoluteCursor,
    composition:
      composition === null
        ? null
        : {
            start: byteLength(prefix),
            end: byteLength(prefix) + byteLength(inserted),
          },
  };
};

const previous = (text: string, offset: number) => {
  const snapped = normalizeOffset(text, offset);
  let result = 0;
  for (const scalar of scalars(text)) {
    if (scalar.end >= snapped) break;
    result = scalar.end;
  }
  return result;
};

const next = (text: string, offset: number) => {
  const snapped = normalizeOffset(text, offset);
  for (const scalar of scalars(text)) if (scalar.end > snapped) return scalar.end;
  return byteLength(text);
};

const isWord = (scalar: string) => {
  const codePoint = scalar.codePointAt(0);
  return /[A-Za-z0-9_]/.test(scalar) || (codePoint !== undefined && codePoint > 0x7f);
};

const previousWord = (text: string, offset: number) => {
  let cursor = normalizeOffset(text, offset);
  while (cursor > 0 && !isWord(scalarBefore(text, cursor))) cursor = previous(text, cursor);
  while (cursor > 0 && isWord(scalarBefore(text, cursor))) cursor = previous(text, cursor);
  return cursor;
};

const nextWord = (text: string, offset: number) => {
  let cursor = normalizeOffset(text, offset);
  while (cursor < byteLength(text) && !isWord(scalarAt(text, cursor))) cursor = next(text, cursor);
  while (cursor < byteLength(text) && isWord(scalarAt(text, cursor))) cursor = next(text, cursor);
  return cursor;
};

const scalarAt = (text: string, offset: number) =>
  scalars(text).find((scalar) => scalar.start === normalizeOffset(text, offset))?.text ?? "";
const scalarBefore = (text: string, offset: number) => scalarAt(text, previous(text, offset));

const collapse = (state: NativeTextInputState, offset: number): NativeTextInputState => ({
  text: state.text,
  anchor: offset,
  focus: offset,
  composition: null,
});

const deleteRange = (state: NativeTextInputState, start: number, end: number) =>
  replace({ ...state, composition: range(state.text, start, end) }, "", null, 0);

const moveCaret = (
  state: NativeTextInputState,
  direction: NativeCaretDirection,
  extend: boolean,
): NativeTextInputState => {
  const selection = selectedRange(state);
  const focus = normalizeOffset(state.text, state.focus);
  const target = (() => {
    if (!extend && selection.start !== selection.end) {
      if (direction === "previous" || direction === "previous_word") return selection.start;
      if (direction === "next" || direction === "next_word") return selection.end;
    }
    switch (direction) {
      case "previous":
        return previous(state.text, focus);
      case "next":
        return next(state.text, focus);
      case "previous_word":
        return previousWord(state.text, focus);
      case "next_word":
        return nextWord(state.text, focus);
      case "start":
        return 0;
      case "end":
        return byteLength(state.text);
    }
  })();
  return extend
    ? { text: state.text, anchor: state.anchor, focus: target, composition: null }
    : collapse(state, target);
};

/** Applies exactly the thirteen Native canvas TextInputEvent wire variants. */
export const reduceNativeTextInput = (
  input: NativeTextInputState,
  event: NativeTextInputEvent,
): NativeTextInputState => {
  const state = normalizeState(input);
  const selection = activeRange(state);
  let nextState: NativeTextInputState;
  switch (event.kind) {
    case "insert_text":
      nextState = replace(state, event.text, null, byteLength(event.text));
      break;
    case "set_composition":
      nextState = replace(
        state,
        event.text,
        { start: 0, end: 0 },
        event.cursor ?? byteLength(event.text),
      );
      break;
    case "commit_composition":
      nextState = { ...state, composition: null };
      break;
    case "cancel_composition":
      nextState =
        state.composition === null
          ? state
          : deleteRange(state, state.composition.start, state.composition.end);
      break;
    case "clear":
      nextState = { text: "", anchor: 0, focus: 0, composition: null };
      break;
    case "set_selection":
      nextState = {
        text: state.text,
        anchor: normalizeOffset(state.text, event.anchor, true),
        focus: normalizeOffset(state.text, event.focus, true),
        composition: null,
      };
      break;
    case "move_caret":
      nextState = moveCaret(state, event.direction, event.extend);
      break;
    case "delete_backward":
      nextState =
        selection.start === selection.end
          ? deleteRange(state, previous(state.text, state.focus), state.focus)
          : deleteRange(state, selection.start, selection.end);
      break;
    case "delete_forward":
      nextState =
        selection.start === selection.end
          ? deleteRange(state, state.focus, next(state.text, state.focus))
          : deleteRange(state, selection.start, selection.end);
      break;
    case "delete_word_backward":
      nextState =
        selection.start === selection.end
          ? deleteRange(state, previousWord(state.text, state.focus), state.focus)
          : deleteRange(state, selection.start, selection.end);
      break;
    case "delete_word_forward":
      nextState =
        selection.start === selection.end
          ? deleteRange(state, state.focus, nextWord(state.text, state.focus))
          : deleteRange(state, selection.start, selection.end);
      break;
    case "delete_to_start":
      nextState =
        selection.start === selection.end
          ? deleteRange(state, 0, state.focus)
          : deleteRange(state, selection.start, selection.end);
      break;
    case "delete_to_line_start": {
      const before = splitAt(state.text, state.focus)[0];
      const lineStart = byteLength(before.slice(0, before.lastIndexOf("\n") + 1));
      nextState =
        selection.start === selection.end
          ? deleteRange(state, lineStart, state.focus)
          : deleteRange(state, selection.start, selection.end);
      break;
    }
  }
  return normalizeState(nextState);
};

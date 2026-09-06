import assert from "node:assert/strict";
import test from "node:test";
import { reduceNativeTextInput, type NativeTextInputState } from "../src/text-input.ts";

const state = (
  text: string,
  anchor = new TextEncoder().encode(text).byteLength,
  focus = anchor,
): NativeTextInputState => ({
  text,
  anchor,
  focus,
  composition: null,
});

test("replaces the selected UTF-8 byte range", () => {
  const next = reduceNativeTextInput(state("hello", 1, 4), {
    kind: "insert_text",
    text: "α",
  });
  assert.deepEqual(next, state("hαo", 3));
});

test("moves and deletes complete UTF-8 scalars for emoji and CJK", () => {
  const text = "A😀界";
  const afterCjk = reduceNativeTextInput(state(text), { kind: "delete_backward" });
  assert.deepEqual(afterCjk, state("A😀", 5));
  const afterEmoji = reduceNativeTextInput(afterCjk, { kind: "delete_backward" });
  assert.deepEqual(afterEmoji, state("A", 1));

  const selectedToEnd = reduceNativeTextInput(state(text), {
    kind: "set_selection",
    anchor: 1,
    focus: -1,
    affinity: "upstream",
  });
  assert.deepEqual(selectedToEnd, state(text, 1, 8));
});

test("keeps composition separate until commit or cancel", () => {
  const composing = reduceNativeTextInput(state("go"), {
    kind: "set_composition",
    text: "日本",
    cursor: 3,
  });
  assert.deepEqual(composing, {
    text: "go日本",
    anchor: 5,
    focus: 5,
    composition: { start: 2, end: 8 },
  });
  const updated = reduceNativeTextInput(composing, {
    kind: "set_composition",
    text: "日本語",
    cursor: null,
  });
  assert.deepEqual(updated, {
    text: "go日本語",
    anchor: 11,
    focus: 11,
    composition: { start: 2, end: 11 },
  });
  assert.deepEqual(reduceNativeTextInput(updated, { kind: "commit_composition" }), {
    ...updated,
    composition: null,
  });
  assert.deepEqual(
    reduceNativeTextInput(composing, { kind: "cancel_composition" }),
    state("go", 2),
  );
});

test("handles paste and caps text without splitting a UTF-8 scalar", () => {
  const pasted = reduceNativeTextInput(state("ab", 1, 2), {
    kind: "insert_text",
    text: "😀界",
  });
  assert.deepEqual(pasted, state("a😀界", 8));

  const capped = reduceNativeTextInput(state("x".repeat(4092)), {
    kind: "insert_text",
    text: "😀z",
  });
  assert.equal(capped.text, "x".repeat(4092) + "😀");
  assert.equal(new TextEncoder().encode(capped.text).byteLength, 4096);
  assert.equal(capped.focus, 4096);
});

test("implements Native caret and delete variants", () => {
  const moved = reduceNativeTextInput(state("one two", 7), {
    kind: "move_caret",
    direction: "previous_word",
    extend: false,
  });
  assert.deepEqual(moved, state("one two", 4));
  assert.deepEqual(reduceNativeTextInput(moved, { kind: "delete_word_forward" }), state("one ", 4));
  assert.deepEqual(
    reduceNativeTextInput(state("one\ntwo", 7), { kind: "delete_to_line_start" }),
    state("one\n", 4),
  );
});

import { Schema } from "effect";
import {
  TabState,
  PinState,
  LayoutState,
  Select,
  Empty,
  Open,
  Reorder,
  Pin,
  SetPresentation,
} from "./contracts.ts";

const json = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema).schema;
const document = (
  name: string,
  state: Schema.Top,
  methods: Readonly<Record<string, Schema.Top>>,
) => ({
  format: "hitchhiker-service-contract/1",
  name,
  version: "1.0.0",
  state: json(state),
  methods: Object.fromEntries(
    Object.entries(methods).map(([method, params]) => [
      method,
      { params: json(params), result: json(state) },
    ]),
  ),
});
/** The published bytes are checked against these executable decoders at build time. */
export const contractDocuments = {
  model: document("browser.tabs.model", TabState, {
    select: Select,
    new: Empty,
    open: Open,
    close: Select,
    reorder: Reorder,
  }),
  pins: document("browser.tabs.pins", PinState, { set: Pin }),
  layout: document("browser.shell.layout", LayoutState, { setPresentation: SetPresentation }),
};

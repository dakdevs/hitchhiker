import { Schema } from "effect";
import { validator } from "@exodus/schemasafe";

/** Compile trusted authored schemas once; generated plugins need neither Effect nor dynamic eval. */
export const compileSchemas = (exports) => {
  const code = [];
  for (const [name, schema] of Object.entries(exports)) {
    if (!Schema.isSchema(schema)) continue;
    const document = Schema.toJsonSchemaDocument(schema);
    const formats = {};
    const visit = (value) => {
      if (!value || typeof value !== "object") return;
      if (typeof value.format === "string" && /^utf16-max-[0-9]+$/.test(value.format)) {
        const maximum = Number(value.format.slice(10));
        if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid UTF-16 limit");
        formats[value.format] = new Function("value", `return value.length <= ${maximum}`);
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(document.schema);
    visit(document.definitions);
    const validate = validator(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...document.schema,
        $defs: document.definitions,
      },
      { isJSON: true, formats },
    );
    code.push(`export const ${name} = ${validate.toModule()};`);
  }
  if (Object.hasOwn(exports, "decode"))
    code.push(
      'export const decode = (validate, value) => { if (!validate(value)) throw new Error("Invalid plugin contract value"); return value; };',
    );
  return code.join("\n");
};

// Minimal Zod → JSON Schema converter for MCP tool input schemas.
// Only handles the subset of Zod types used in tools.ts.
// For a full implementation, use the "zod-to-json-schema" package.

import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonSchema = Record<string, any>;

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convertZod(schema);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertZod(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convertZod(value);
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }
    const result: JsonSchema = { type: "object", properties };
    if (required.length) result.required = required;
    return withDescription(schema, result);
  }

  if (schema instanceof z.ZodOptional) {
    return convertZod(schema.unwrap());
  }

  if (schema instanceof z.ZodString) {
    return withDescription(schema, { type: "string" });
  }

  if (schema instanceof z.ZodNumber) {
    const result: JsonSchema = { type: "number" };
    if ((schema as z.ZodNumber).isInt) result.type = "integer";
    const checks = (schema as z.ZodNumber)._def.checks as Array<{kind: string; value: number}>;
    for (const check of checks) {
      if (check.kind === "min") result.minimum = check.value;
      if (check.kind === "max") result.maximum = check.value;
    }
    return withDescription(schema, result);
  }

  if (schema instanceof z.ZodBoolean) {
    return withDescription(schema, { type: "boolean" });
  }

  if (schema instanceof z.ZodEnum) {
    return withDescription(schema, { type: "string", enum: schema.options });
  }

  if (schema instanceof z.ZodArray) {
    return withDescription(schema, {
      type: "array",
      items: convertZod(schema.element),
    });
  }

  if (schema instanceof z.ZodLiteral) {
    return withDescription(schema, { const: schema.value });
  }

  if (schema instanceof z.ZodUnion) {
    return withDescription(schema, {
      anyOf: (schema.options as z.ZodTypeAny[]).map(convertZod),
    });
  }

  // Fallback
  return {};
}

function withDescription(schema: z.ZodTypeAny, result: JsonSchema): JsonSchema {
  const desc = schema.description;
  if (desc) result.description = desc;
  return result;
}

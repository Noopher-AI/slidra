// The machine-readable half of the specification (spec/schema/): JSON
// Schemas for project.json and for the Slidra SVG vocabulary, compiled once.
// Node-only (it reads the schema files from disk, unless bundled); the browser viewer keeps
// its hand-written checks, and test/schema.test.mjs holds the two to the
// same verdicts.

import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/* global __SLIDRA_SCHEMAS__ */
/** The schemas, inlined by tools/build-bundle.mjs into the self-contained validator; unbundled, they are read from spec/schema/. */
const BUILT_IN_SCHEMAS = typeof __SLIDRA_SCHEMAS__ === "object" && __SLIDRA_SCHEMAS__ !== null ? __SLIDRA_SCHEMAS__ : null;
const read = (name) => (BUILT_IN_SCHEMAS ? BUILT_IN_SCHEMAS[name] : JSON.parse(readFileSync(new URL(`../spec/schema/${name}`, import.meta.url), "utf8")));

export const projectSchema = read("project.schema.json");
export const metadataSchema = read("metadata.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(metadataSchema);
const projectValidator = ajv.compile(projectSchema);

/** Names of the vocabulary definitions an element's attributes can be checked against. */
export const VOCABULARY = Object.freeze(["effect", "transition", "notes", "comment", "chart", "series", "categories", "source", "element", "slide", "cell", "tspan"]);

const vocabularyValidators = new Map(VOCABULARY.map((name) => [name, ajv.getSchema(`${metadataSchema.$id}#/$defs/${name}`)]));

/**
 * @typedef {{ path: string, message: string }} SchemaIssue
 * @param {import("ajv").ErrorObject[] | null | undefined} errors
 * @returns {SchemaIssue[]}
 */
function issues(errors) {
  return (errors ?? []).filter((error) => error.keyword !== "if").map((error) => ({ path: error.instancePath || "/", message: error.message ?? error.keyword }));
}

/** Validates a parsed project.json. Returns the problems found; an empty list means valid. */
export function checkProject(project) {
  return projectValidator(project) ? [] : issues(projectValidator.errors);
}

/**
 * Validates one element's attributes against the vocabulary definition `name`.
 * @param {string} name one of VOCABULARY
 * @param {Record<string, string>} attributes
 */
export function checkAttributes(name, attributes) {
  const validate = vocabularyValidators.get(name);
  if (!validate) throw new Error(`unknown vocabulary definition "${name}"`);
  return validate(attributes) ? [] : issues(validate.errors);
}

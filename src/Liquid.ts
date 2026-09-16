import { Layer } from "effect";
import { layer as renderLayer } from "./Render.js";
import { memory } from "./TemplateLoader.js";

export { analyze } from "./Analyze.js";
export { check } from "./Check.js";
export { parse } from "./Parser.js";
export { render, renderStream } from "./Render.js";
export const layer = Layer.merge(renderLayer(), memory());
export { checkProject } from "./CheckProject.js";
export { analyzeProject } from "./Project.js";

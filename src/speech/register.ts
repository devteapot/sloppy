// First-party protocol registrations. Importing this module (directly or via
// the profile manager) guarantees the built-in protocols are present in
// `speechRegistry`; plugins add theirs with registry.register*().

import { OpenAISpeechStreamAdapter } from "./openai-speech";
import { RealtimeSttAdapter } from "./realtime-stt/session";
import { speechRegistry } from "./registry";

speechRegistry.registerStt("realtime-stt", (config) => new RealtimeSttAdapter(config));
speechRegistry.registerTts("openai-speech", (config) => new OpenAISpeechStreamAdapter(config));

export { speechRegistry };

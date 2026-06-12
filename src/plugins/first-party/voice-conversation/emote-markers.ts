// Inline emote markers: `[emote:name]` embedded by the model in voice-turn
// replies. Markers are stripped from the spoken text and split the reply into
// segments; each marked segment plays the named robot emotion as its audio
// starts. Parsing is tolerant (case, internal whitespace, empty names) so a
// malformed marker is never spoken aloud.
//
// Markers survive normalizeForSpeech (its link regex needs a trailing `(...)`),
// so stripping MUST happen here, before any text reaches a TTS stream.

const EMOTE_MARKER = /\[\s*emote\s*:\s*([\w.-]*)\s*\]/gi;

export type EmoteSegment = {
  /** Validated emotion name to fire as this segment starts; absent for the
   * leading unmarked text and for markers that failed validation. */
  emotion?: string;
  text: string;
};

export function hasEmoteMarkers(text: string): boolean {
  EMOTE_MARKER.lastIndex = 0;
  return EMOTE_MARKER.test(text);
}

/**
 * Split a reply into spoken segments at emote markers.
 *
 * `validNames === null` means the emotion vocabulary could not be read (provider
 * down, props.emotions absent): markers still fire and the provider's own
 * invalid_params rejection absorbs bad names. With a vocabulary, unknown names
 * are dropped (marker stripped, text kept).
 */
export function parseEmoteMarkers(text: string, validNames: string[] | null): EmoteSegment[] {
  EMOTE_MARKER.lastIndex = 0;
  const valid = validNames === null ? null : new Set(validNames.map((name) => name.toLowerCase()));
  const segments: EmoteSegment[] = [{ text: "" }];
  let cursor = 0;
  for (let match = EMOTE_MARKER.exec(text); match; match = EMOTE_MARKER.exec(text)) {
    const before = text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    segments[segments.length - 1].text += before;
    const name = match[1].toLowerCase();
    if (name && (valid === null || valid.has(name))) {
      segments.push({ emotion: name, text: "" });
    } else {
      // Unknown or empty name: strip the marker, keep surrounding text joined.
      segments[segments.length - 1].text += " ";
    }
  }
  segments[segments.length - 1].text += text.slice(cursor);
  for (const segment of segments) {
    segment.text = segment.text.replace(/[ \t]{2,}/g, " ").trim();
  }
  // Drop empty filler (e.g. the leading segment when the reply starts with a
  // marker). Segments after the first always carry an emotion, so this only
  // ever removes do-nothing entries.
  return segments.filter((segment) => segment.emotion || segment.text.length > 0);
}

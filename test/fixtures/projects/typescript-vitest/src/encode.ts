/**
 * Percent-encoding as RFC 3986 defines it. `encodeURIComponent` leaves `!'()*` alone, which are reserved sub-delimiters, so
 * they are escaped here as well.
 */
export function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Decodes a query component, with `+` as a space. A malformed escape, such as a lone `%`, is kept as written rather than
 * throwing, and the escapes around it are still decoded.
 */
export function decodeComponent(value: string): string {
  const spaced = value.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced.replace(/(%[0-9A-Fa-f]{2})+/g, run => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/** Whether `value` holds a percent escape that decodes to something other than itself. */
export function isEncoded(value: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(value) && decodeComponent(value) !== value;
}

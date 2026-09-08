// Region enum for profile + job forms. Product default is always US.
export const LOCATION_FLAGS = ['US', 'Brazil', 'EU', 'Asia', 'Other'];

/** Always US — do not infer EU/Brazil/Asia from city or URL text. */
export function detectLocationFlagClient(_text) {
    return 'US';
}

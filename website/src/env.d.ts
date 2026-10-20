// why: nothing in src imports the Starlight integration itself, so without this
// `Astro.locals.starlightRoute` does not type-check.
/// <reference types="@astrojs/starlight" />

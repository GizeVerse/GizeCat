// The build-time slot for the owner-provisioned encrypted payload (see scripts/build.mjs and
// secrets/README-PRIVATE.md). It is the empty string unless the build embedded a payload;
// it is ciphertext only, never a trigger or a message.
declare const __EGG_PAYLOAD__: string | undefined;

export const EMBEDDED_EGG_PAYLOAD: string = typeof __EGG_PAYLOAD__ === 'string' ? __EGG_PAYLOAD__ : '';

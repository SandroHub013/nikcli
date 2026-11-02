/**
 * What a transport says when the session it was asked to use was cancelled from
 * outside — the xAI key removed while a frame was on its way. Not a network
 * failure: the sentence goes to the batch, and no pause is owed (review S7, B2).
 *
 * Its own file so ADE's host side can name it without loading the transcriber
 * (and the Effect runtime) that `./grok-stream` brings.
 */
export const STT_STREAM_CANCELLED = "stt_stream cancelled"

import type { VoiceEngine } from "../engine"

export async function submitVoiceTrial(engine: Pick<VoiceEngine, "submitText">, text: string): Promise<void> {
  await engine.submitText(text)
}

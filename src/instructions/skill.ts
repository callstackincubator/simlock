const SKILL_DESCRIPTION =
  "Use before touching an iOS simulator, Android emulator or test phone, or running simctl, adb, emulator, xcodebuild for a simulator, or agent-device.";

export function renderSkill(): string {
  return `---\nname: simlock\ndescription: ${SKILL_DESCRIPTION}\n---\n\nRun \`simlock instructions\` and follow them.\n`;
}

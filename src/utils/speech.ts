let speaking = false

export function speak(text: string, lang = 'zh-CN'): void {
  if (!('speechSynthesis' in window)) return
  if (speaking) return
  speaking = true
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang
  utterance.rate = 0.9
  utterance.pitch = 1.0
  utterance.onend = () => { speaking = false }
  utterance.onerror = () => { speaking = false }
  window.speechSynthesis.speak(utterance)
}

export function speakReminder(): void {
  speak('该休息一下了！请做一个简短的肩颈放松活动。')
}

export function speakPostureIssue(issues: string[]): void {
  if (issues.length === 0) return
  const text = `检测到${issues.join('、')}，请注意调整坐姿。`
  speak(text)
}

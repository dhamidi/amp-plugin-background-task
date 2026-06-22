import type { PluginAPI } from '@ampcode/plugin'
import { registerBackgroundTaskTool } from './register'

export default function backgroundTaskPlugin(amp: PluginAPI): void {
	registerBackgroundTaskTool(amp)
}

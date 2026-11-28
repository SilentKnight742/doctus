/*
 * The API the screens use. P0 (this prototype) runs on the in-browser mock;
 * N1 adds an HTTP implementation of the same interface against FastAPI.
 */
import { makeMockApi } from '../mock/mockApi'
import type {
  ChatEvents,
  ChatMessage,
  ChatScope,
  ConnectionView,
  Id,
  PromptSuggestion,
  Reason,
  ReasonInput,
  SelectionInput,
  Space,
  SpaceView,
  Widget,
  WidgetInput,
  WidgetPatch,
  World,
  WorldInput,
  WorldView,
} from './types'

export { ApiError, ModelBusy, RateLimited, describeError, errorFor } from './errors'

export interface DoctusApi {
  /** `mock` in the prototype; `http` from N1. */
  kind: 'mock' | 'http'
  /** Called after any change (including an agent's tool calls mid-reply). */
  subscribe(fn: () => void): () => void

  listSpaces(): Promise<Space[]>
  createSpace(title: string, description?: string): Promise<Space>
  updateSpace(id: Id, patch: { title?: string; description?: string }): Promise<Space>
  deleteSpace(id: Id): Promise<void>
  /** The space canvas: worlds, derived connections, space-level widgets, types. */
  getSpace(id: Id): Promise<SpaceView>

  createWorld(spaceId: Id, input: WorldInput): Promise<World>
  updateWorld(id: Id, patch: Partial<Pick<World, 'title' | 'summary' | 'colour' | 'x' | 'y'>>): Promise<World>
  deleteWorld(id: Id): Promise<void>
  getWorld(id: Id): Promise<WorldView>

  createWidget(input: WidgetInput): Promise<Widget>
  updateWidget(id: Id, patch: WidgetPatch): Promise<Widget>
  deleteWidget(id: Id): Promise<void>

  getConnection(worldA: Id, worldB: Id): Promise<ConnectionView>
  createReason(input: ReasonInput): Promise<Reason>
  updateReason(id: Id, patch: { kind?: string; text?: string }): Promise<Reason>
  deleteReason(id: Id): Promise<void>
  newWorldFromSelection(input: SelectionInput): Promise<World>

  messages(scope: ChatScope): Promise<ChatMessage[]>
  suggestions(scope: ChatScope): Promise<PromptSuggestion[]>
  /** Send a message and stream the agent's reply; resolves with the saved reply. */
  chat(scope: ChatScope, text: string, events?: ChatEvents): Promise<ChatMessage>

  /** Prototype only: drop local changes and load the seed again. */
  resetDemo(): Promise<void>
}

export const api: DoctusApi = makeMockApi()

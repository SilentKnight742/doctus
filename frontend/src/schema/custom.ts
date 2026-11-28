/*
 * Two non-builtin types, defined through the same schema system a user or
 * the AI will use later. The seed attaches them to the Petstore space.
 */
import type { WidgetType } from '../api/types'

export function decisionType(spaceId: number): WidgetType {
  return {
    name: 'decision',
    label: 'Decision',
    description: 'An open product decision: options, status, owner and due date.',
    builtin: false,
    space_id: spaceId,
    view: 'card',
    view_options: { title: 'question', badge: 'status' },
    fields: [
      { key: 'question', label: 'Question', type: 'text', required: true },
      { key: 'status', label: 'Status', type: 'enum', options: ['Open', 'Decided', 'Parked'] },
      { key: 'owner', label: 'Owner', type: 'text' },
      { key: 'due', label: 'Due', type: 'date' },
      {
        key: 'options',
        label: 'Options',
        type: 'table',
        fields: [
          { key: 'option', label: 'Option', type: 'text' },
          { key: 'tradeoff', label: 'Trade-off', type: 'text' },
        ],
      },
      { key: 'outcome', label: 'Outcome', type: 'text' },
    ],
    default_size: { w: 360, h: 280 },
  }
}

export function trackerType(spaceId: number): WidgetType {
  return {
    name: 'tracker',
    label: 'Tracker',
    description: 'Space-level progress across worlds: items, owners, status.',
    builtin: false,
    space_id: spaceId,
    view: 'table',
    view_options: { title: 'title', items: 'items', progress: { by: 'status', done: 'Ready' } },
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      {
        key: 'items',
        label: 'Items',
        type: 'table',
        fields: [
          { key: 'item', label: 'Item', type: 'text' },
          { key: 'world', label: 'World', type: 'ref', ref_kind: 'world' },
          { key: 'owner', label: 'Owner', type: 'text' },
          { key: 'status', label: 'Status', type: 'enum', options: ['Not started', 'In progress', 'Blocked', 'Ready'] },
          { key: 'due', label: 'Due', type: 'date' },
        ],
      },
    ],
    default_size: { w: 420, h: 300 },
  }
}

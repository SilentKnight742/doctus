/*
 * The built-in widget types. They use the same schema system as user- or
 * AI-defined types (see the `decision` and `tracker` types in the seed).
 */
import type { FieldDef, WidgetType } from '../api/types'

const title: FieldDef = { key: 'title', label: 'Title', type: 'text', required: true }

export const NOTE: WidgetType = {
  name: 'note',
  label: 'Note',
  description: 'Free text in Markdown.',
  builtin: true,
  space_id: null,
  view: 'card',
  view_options: { title: 'title', lead: 'body' },
  fields: [title, { key: 'body', label: 'Body', type: 'text' }],
  default_size: { w: 300, h: 200 },
}

export const IMAGE: WidgetType = {
  name: 'image',
  label: 'Image',
  description: 'A screenshot, sketch or photo with a caption.',
  builtin: true,
  space_id: null,
  view: 'image',
  view_options: { title: 'title', lead: 'caption' },
  fields: [
    title,
    { key: 'image', label: 'Image', type: 'file' },
    { key: 'caption', label: 'Caption', type: 'text' },
  ],
  default_size: { w: 380, h: 320 },
}

export const LINK: WidgetType = {
  name: 'link',
  label: 'Link',
  description: 'A web page, with a short description.',
  builtin: true,
  space_id: null,
  view: 'embed',
  view_options: { title: 'title', lead: 'description' },
  fields: [
    title,
    { key: 'url', label: 'URL', type: 'url', required: true },
    { key: 'description', label: 'Description', type: 'text' },
  ],
  default_size: { w: 300, h: 150 },
}

/** Columns are named by the `columns` list; rows have up to five text cells. */
export const TABLE: WidgetType = {
  name: 'table',
  label: 'Table',
  description: 'Rows and named columns.',
  builtin: true,
  space_id: null,
  view: 'table',
  view_options: { title: 'title', items: 'rows', columns: 'columns' },
  fields: [
    title,
    { key: 'columns', label: 'Columns', type: 'list', fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    {
      key: 'rows',
      label: 'Rows',
      type: 'table',
      fields: ['c1', 'c2', 'c3', 'c4', 'c5'].map((k, i) => ({ key: k, label: `Column ${i + 1}`, type: 'text' })),
    },
  ],
  default_size: { w: 440, h: 240 },
}

export const CHECKLIST: WidgetType = {
  name: 'checklist',
  label: 'Checklist',
  description: 'Items to tick off.',
  builtin: true,
  space_id: null,
  view: 'checklist',
  view_options: { title: 'title', items: 'items', check: 'done' },
  fields: [
    title,
    {
      key: 'items',
      label: 'Items',
      type: 'list',
      fields: [
        { key: 'done', label: 'Done', type: 'bool' },
        { key: 'text', label: 'Item', type: 'text' },
      ],
    },
  ],
  default_size: { w: 300, h: 220 },
}

export const OPENAPI_ENDPOINT: WidgetType = {
  name: 'openapi_endpoint',
  label: 'API endpoint',
  description: 'One OpenAPI operation: method, path, parameters, request and responses.',
  builtin: true,
  space_id: null,
  view: 'card',
  view_options: { title: 'path', title_prefix: 'method', badge: 'method', lead: 'summary' },
  fields: [
    { key: 'method', label: 'Method', type: 'enum', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { key: 'path', label: 'Path', type: 'text', required: true },
    { key: 'summary', label: 'Summary', type: 'text' },
    {
      key: 'parameters',
      label: 'Parameters',
      type: 'table',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'in', label: 'In', type: 'enum', options: ['path', 'query', 'header', 'cookie'] },
        { key: 'type', label: 'Type', type: 'text' },
        { key: 'required', label: 'Required', type: 'bool' },
      ],
    },
    { key: 'request', label: 'Request body', type: 'code', language: 'json' },
    {
      key: 'responses',
      label: 'Responses',
      type: 'table',
      fields: [
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'description', label: 'Description', type: 'text' },
      ],
    },
  ],
  default_size: { w: 360, h: 300 },
}

export const BUILTIN_TYPES: WidgetType[] = [NOTE, IMAGE, LINK, TABLE, CHECKLIST, OPENAPI_ENDPOINT]

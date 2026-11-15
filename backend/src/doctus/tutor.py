"""The tutor: talks with the learner. It never sees graph instructions; the
graph only reaches it as quiet background notes (see context.py)."""

from .context import TopicContext, build_topic_context
from .llm import LLM, Turn
from .prompts import ORIGIN_SCOPE, TOPIC_SCOPE, TUTOR_SYSTEM
from .store import Node, Store


def system_prompt(subject: dict, node: Node, ctx: TopicContext) -> str:
    is_origin = node.id == subject["origin_node_id"]
    return TUTOR_SYSTEM.format(scope=ORIGIN_SCOPE if is_origin else TOPIC_SCOPE, notes=ctx.text)


def reply(
    store: Store, llm: LLM, subject: dict, node: Node, message: str, recent_turns: int
) -> tuple[str, TopicContext, int]:
    """(reply, context used, number of history turns sent)."""
    ctx = build_topic_context(store, subject, node)
    history = store.recent_messages(subject["id"], node.id, recent_turns)
    turns = [Turn(m.role, m.content) for m in history] + [Turn("user", message)]
    return llm.chat(system_prompt(subject, node, ctx), turns), ctx, len(history)

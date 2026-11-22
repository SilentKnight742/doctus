"""The tutor: talks with the learner. It never sees graph instructions; the
canvas only reaches it as its branch's conversation plus quiet background
notes (see context.py)."""

from collections.abc import Iterator

from .context import BranchContext, build_branch_context
from .llm import LLM
from .prompts import BRANCH_SCOPE, ORIGIN_SCOPE, TUTOR_SYSTEM
from .store import CanvasNode, Store


def system_prompt(ctx: BranchContext) -> str:
    return TUTOR_SYSTEM.format(scope=ORIGIN_SCOPE if ctx.is_root else BRANCH_SCOPE, notes=ctx.text)


def stream_reply(
    store: Store, llm: LLM, subject: dict, node: CanvasNode, budget: int
) -> tuple[Iterator[str], BranchContext]:
    """Stream the answer to the node's latest (unanswered) question."""
    ctx = build_branch_context(store, subject, node, budget)
    return llm.chat_stream(system_prompt(ctx), ctx.turns), ctx

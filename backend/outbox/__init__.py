"""User-confirmed send and scheduled-message layer."""
from .automation import (
    DEFAULT_AUTOMATION_ALLOWED_SKILL_KEYS,
    AutomationDecision,
    OutboxAutomation,
)
from .adapters import (
    SendAdapterResult,
    SendRequest,
    SenderAdapterRegistry,
    UnsupportedSenderAdapter,
    UserSessionSenderAdapter,
)
from .planner import OutboxPlan, OutboxPlanner
from .send import SkillSendResult, SkillSendService
from .worker import OutboxAutomationWorker

__all__ = [
    "DEFAULT_AUTOMATION_ALLOWED_SKILL_KEYS",
    "AutomationDecision",
    "OutboxAutomation",
    "SendAdapterResult",
    "SendRequest",
    "SenderAdapterRegistry",
    "UnsupportedSenderAdapter",
    "UserSessionSenderAdapter",
    "OutboxPlan",
    "OutboxPlanner",
    "OutboxAutomationWorker",
    "SkillSendResult",
    "SkillSendService",
]

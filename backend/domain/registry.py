from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .models import ParsedCard, RawMessageEvent, ResourceDelta, StatePatch


@dataclass(frozen=True)
class ParserOutput:
    cards: tuple[ParsedCard, ...] = ()
    state_patches: tuple[StatePatch, ...] = ()
    resource_deltas: tuple[ResourceDelta, ...] = ()


class Parser(Protocol):
    name: str

    def parse(self, event: RawMessageEvent) -> ParserOutput | None:
        """Parse one raw message event into UI-facing outputs."""


@dataclass
class ParserRegistry:
    parsers: list[Parser] = field(default_factory=list)

    def register(self, parser: Parser) -> None:
        self.parsers.append(parser)

    def parse(self, event: RawMessageEvent) -> ParserOutput:
        cards: list[ParsedCard] = []
        state_patches: list[StatePatch] = []
        resource_deltas: list[ResourceDelta] = []
        for parser in self.parsers:
            output = parser.parse(event)
            if output is None:
                continue
            cards.extend(output.cards)
            state_patches.extend(output.state_patches)
            resource_deltas.extend(output.resource_deltas)
        return ParserOutput(
            cards=tuple(cards),
            state_patches=tuple(state_patches),
            resource_deltas=tuple(resource_deltas),
        )

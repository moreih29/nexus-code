from __future__ import annotations


class Greeter:
    def __init__(self, prefix: str = "Hello") -> None:
        self.prefix = prefix

    def greet(self, name: str) -> str:
        return format_greeting(self.prefix, name)


def format_greeting(prefix: str, name: str) -> str:
    return f"{prefix}, {name}!"


def make_greeter() -> Greeter:
    greeter = Greeter()
    return greeter


def update_counter() -> int:
    counter = 0
    counter = counter + 1
    return counter

from module_a import Greeter, make_greeter


def greet_user(name: str) -> str:
    greeter = make_greeter()
    return greeter.greet(name)


class FriendlyGreeter(Greeter):
    def welcome(self) -> str:
        return self.greet("friend")

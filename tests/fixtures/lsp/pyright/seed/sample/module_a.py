class Greeter:
    def greet(self, name: str) -> str:
        return f"Hello, {name}!"


def make_greeter() -> Greeter:
    return Greeter()

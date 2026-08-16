"""Fast router tests (port of src/agents/fastRouter.ts behavior)."""

from grace.agents.fast_router import classify_task, conversation_reply


def test_greetings_are_conversation():
    for text in ["hi", "hello", "hey there", "good morning", "thanks", "bye", "who are you?"]:
        assert classify_task(text) == "conversation", text


def test_conversation_replies_are_local():
    assert "building" in conversation_reply("hi")
    assert "Anytime" in conversation_reply("thanks")
    assert "exit" in conversation_reply("bye")
    assert "GRACE" in conversation_reply("what can you do")


def test_pure_test_runs_are_tests():
    for text in ["run the tests", "run tests", "are the tests passing?", "run npm test", "check the typecheck"]:
        assert classify_task(text) == "tests", text


def test_fix_tasks_are_coding_not_tests():
    assert classify_task("run the tests and fix failures") == "coding"
    assert classify_task("fix the failing test") == "coding"


def test_inspect_tasks_are_inspect():
    for text in ["explain what src/ does", "what does package.json contain?", "describe the auth flow", "why is the build failing?"]:
        assert classify_task(text) == "inspect", text


def test_complex_tasks_are_complex():
    for text in ["redesign the authentication system", "migrate the project to Python", "design a database schema"]:
        assert classify_task(text) == "complex", text


def test_plain_coding_tasks_default_to_coding():
    for text in ["fix the login bug", "add a calculator.py", "update the README"]:
        assert classify_task(text) == "coding", text

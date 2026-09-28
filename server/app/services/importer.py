"""聊天记录解析器。

把粘贴的聊天文本解析成结构化消息 [{speaker:"me"|"them", text}]，
供：(1) 嵌入对方消息做向量记忆；(2) 第三方分析师读取归纳性格。

约定：行首「名字：内容」识别说话人；名字匹配 my_name→me，匹配
their_name→them；无前缀的行视为上一条消息的续行（合并）；空行断开当前消息。
识别不了的说话人前缀也当续行，避免丢内容。
"""

import re
from dataclasses import dataclass

_SPEAKER_RE = re.compile(r"^\s*(.+?)\s*[：:]\s*(.*)$")


@dataclass
class ParsedMsg:
    speaker: str  # "me" | "them"
    text: str


def parse_chat(raw_text: str, my_name: str, their_name: str) -> list[ParsedMsg]:
    """解析粘贴文本为消息列表，保留顺序。"""
    my = my_name.strip()
    their = their_name.strip()

    def who(name: str) -> str | None:
        n = name.strip()
        if n == my:
            return "me"
        if n == their:
            return "them"
        return None

    msgs: list[ParsedMsg] = []
    cur_speaker: str | None = None
    cur_lines: list[str] = []

    def flush() -> None:
        nonlocal cur_speaker, cur_lines
        if cur_speaker is not None and cur_lines:
            text = "\n".join(cur_lines).strip()
            if text:
                msgs.append(ParsedMsg(speaker=cur_speaker, text=text))
        cur_speaker = None
        cur_lines = []

    for line in raw_text.splitlines():
        line = line.rstrip()
        if not line.strip():
            flush()
            continue
        m = _SPEAKER_RE.match(line)
        if m:
            w = who(m.group(1))
            if w is not None:
                flush()
                cur_speaker = w
                content = m.group(2)
                cur_lines = [content] if content else []
                continue
        # 续行（无前缀，或前缀不识别）
        if cur_speaker is not None:
            cur_lines.append(line)
    flush()
    return msgs


def them_texts(msgs: list[ParsedMsg]) -> list[str]:
    """取出对方（them）消息文本，供嵌入。"""
    return [m.text for m in msgs if m.speaker == "them" and m.text.strip()]

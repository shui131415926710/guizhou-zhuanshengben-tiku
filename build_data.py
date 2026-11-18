#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把从库课网校（kuke99.com）导出的贵州专升本真题 + 模拟卷 JSON
规范化为站点用的 data.json / data.js。

来源目录：D:\\yx\\llq\\kuke_*.json
文件名约定：
  kuke_{math|eng}_{年份}.json        历年真题
  kuke_{math|eng}_sim_{编号}.json    模拟卷
"""
import json
import re
import os
import glob
import datetime

SRC_DIR = r"D:\yx\llq"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

SUBJECT_NAME = {"math": "高等数学", "eng": "英语"}


def strip_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


def strip_ws_keep_tags(html: str) -> str:
    """收敛空白但保留标签结构（题干里可能有 <p><img><span> 等）"""
    if not html:
        return ""
    html = re.sub(r">\s+<", "><", html)
    return re.sub(r"\s{2,}", " ", html).strip()


def extract_score(stem_html: str):
    m = re.search(r"\((\d+)分\)", stem_html or "")
    return int(m.group(1)) if m else None


def extract_analysis(stat: str) -> str:
    """stat 形如：试题统计： 作答次数829次作答时长0秒 文字解析： ... 试题难度： 中"""
    if not stat:
        return ""
    m = re.search(r"文字解析[：:]\s*(.+?)(?:试题难度|$)", stat, re.S)
    if m:
        return strip_ws(m.group(1)).strip(" .")
    return ""


def parse_filename(name: str):
    m = re.match(r"kuke_(\w+?)_sim_(\d+)\.json", name)
    if m:
        return m.group(1), "sim", int(m.group(2))
    m = re.match(r"kuke_(\w+?)_(\d{4})\.json", name)
    if m:
        return m.group(1), "real", int(m.group(2))
    raise ValueError("文件名不符合约定: " + name)


def parse_file(path: str):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    name = os.path.basename(path)
    tag, category, key = parse_filename(name)
    subj_name = SUBJECT_NAME.get(tag, tag)

    title = (raw.get("title") or "")
    title = title.replace("【历年真题-试题解析】", "").replace("【模拟考场-试题解析】", "").strip()

    questions = []
    for q in raw.get("questions", []):
        stem = q.get("stem") or ""
        opts = q.get("opts") or []
        score = q.get("score") or extract_score(stem)

        options = []
        for o in opts:
            k = (o.get("k") or "").strip()
            if not k:
                continue
            options.append({
                "k": k,
                "html": (o.get("html") or "").strip(),
                "correct": bool(o.get("correct")),
            })

        stat = q.get("stat") or ""
        questions.append({
            "no": q.get("qno"),
            "score": score,
            "type": "choice" if options else "subjective",
            "stem": strip_ws_keep_tags(stem),
            "options": options,
            "answer": strip_ws(q.get("ansText") or ""),
            "answerHtml": (q.get("ansHtml") or "").strip(),
            "analysis": extract_analysis(stat),
            "stats": strip_ws(re.sub(r"文字解析.*", "", stat)),
        })

    questions.sort(key=lambda x: x["no"] or 0)

    if category == "real":
        pid = "%s-%d" % (tag, key)
        label = "%d %s真题" % (key, subj_name)
        fallback_title = "%d贵州专升本%s试题" % (key, subj_name)
        year, sim_no = key, None
    else:
        pid = "%s-sim-%02d" % (tag, key)
        label = "模拟卷 %02d" % key
        fallback_title = "贵州专升本《%s》模拟试卷%02d" % (subj_name, key)
        year, sim_no = None, key

    return {
        "id": pid,
        "subject": tag,
        "subjectName": subj_name,
        "category": category,
        "year": year,
        "simNo": sim_no,
        "label": label,
        "title": title or fallback_title,
        "count": len(questions),
        "totalScore": sum(q["score"] or 0 for q in questions),
        "officialTotal": 150,
        "questions": questions,
    }


def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, "kuke_*.json")))
    if not files:
        raise SystemExit("没有找到源文件")

    papers = [parse_file(p) for p in files]

    def sort_key(p):
        # 科目 -> 分类（真题优先）-> 真题按年份降序 / 模拟卷按编号升序
        cat_order = 0 if p["category"] == "real" else 1
        if p["category"] == "real":
            return (p["subject"], cat_order, -p["year"])
        return (p["subject"], cat_order, p["simNo"])

    papers.sort(key=sort_key)

    real_n = sum(1 for p in papers if p["category"] == "real")
    sim_n = sum(1 for p in papers if p["category"] == "sim")
    total_q = sum(p["count"] for p in papers)

    payload = {
        "source": "库课网校 kuke99.com 贵州专升本题库（历年真题 + 模拟考场）",
        "generated": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "papers": papers,
        "stats": {
            "papers": len(papers),
            "questions": total_q,
            "real": real_n,
            "sim": sim_n,
        },
    }

    base = os.path.dirname(OUT)

    # 1) 完整数据（单文件，便于二次处理）
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    # 2) 站点用：meta（不含题目） + 按科目拆分的数据包（按需加载）
    meta = {
        "source": payload["source"],
        "generated": payload["generated"],
        "stats": payload["stats"],
        "papers": [{k: v for k, v in p.items() if k != "questions"} for p in papers],
    }
    with open(os.path.join(base, "data-meta.js"), "w", encoding="utf-8") as f:
        f.write("window.APP_META=")
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    for subj in sorted({p["subject"] for p in papers}):
        bundle = {p["id"]: p for p in papers if p["subject"] == subj}
        path = os.path.join(base, "data-%s.js" % subj)
        with open(path, "w", encoding="utf-8") as f:
            f.write("(function(){window.SUBJ_DATA=window.SUBJ_DATA||{};window.SUBJ_DATA[%s]=" % json.dumps(subj))
            json.dump(bundle, f, ensure_ascii=False, separators=(",", ":"))
            f.write(";})();\n")

    print("papers=%d (real=%d sim=%d) questions=%d" % (len(papers), real_n, sim_n, total_q))
    for fn in ("data.json", "data-meta.js", "data-math.js", "data-eng.js"):
        p = os.path.join(base, fn)
        if os.path.exists(p):
            print("  %-14s %8.1f KB" % (fn, os.path.getsize(p) / 1024))
    for p in papers[:6]:
        print("  %-14s %-5s n=%-3d total=%s" % (p["id"], p["category"], p["count"], p["totalScore"]))


if __name__ == "__main__":
    main()

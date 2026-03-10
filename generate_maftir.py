import json
import re
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).parent

API_MAP = {
    "בראשית": "Parashat_Bereshit",
    "נח": "Parashat_Noach",
    "לך לך": "Parashat_Lech-Lecha",
    "וירא": "Parashat_Vayera",
    "חיי שרה": "Parashat_Chayei_Sara",
    "תולדות": "Parashat_Toldot",
    "ויצא": "Parashat_Vayetzei",
    "וישלח": "Parashat_Vayishlach",
    "וישב": "Parashat_Vayeshev",
    "מקץ": "Parashat_Miketz",
    "ויגש": "Parashat_Vayigash",
    "ויחי": "Parashat_Vayechi",
    "שמות": "Parashat_Shemot",
    "וארא": "Parashat_Vaera",
    "בא": "Parashat_Bo",
    "בשלח": "Parashat_Beshalach",
    "יתרו": "Parashat_Yitro",
    "משפטים": "Parashat_Mishpatim",
    "תרומה": "Parashat_Terumah",
    "תצוה": "Parashat_Tetzaveh",
    "כי תשא": "Parashat_Ki_Tisa",
    "ויקהל": "Parashat_Vayakhel",
    "פקודי": "Parashat_Pekudei",
    "ויקרא": "Parashat_Vayikra",
    "צו": "Parashat_Tzav",
    "שמיני": "Parashat_Shemini",
    "תזריע": "Parashat_Tazria",
    "מצורע": "Parashat_Metzora",
    "אחרי מות": "Parashat_Achrei_Mot",
    "קדושים": "Parashat_Kedoshim",
    "אמור": "Parashat_Emor",
    "בהר": "Parashat_Behar",
    "בחקתי": "Parashat_Bechukotai",
    "במדבר": "Parashat_Bamidbar",
    "נשא": "Parashat_Naso",
    "בהעלתך": "Parashat_Beha'alotcha",
    "שלח": "Parashat_Sh'lach",
    "קרח": "Parashat_Korach",
    "חקת": "Parashat_Chukat",
    "בלק": "Parashat_Balak",
    "פינחס": "Parashat_Pinchas",
    "מטות": "Parashat_Matot",
    "מסעי": "Parashat_Masei",
    "דברים": "Parashat_Devarim",
    "ואתחנן": "Parashat_Vaetchanan",
    "עקב": "Parashat_Eikev",
    "ראה": "Parashat_Reeh",
    "שופטים": "Parashat_Shoftim",
    "כי תצא": "Parashat_Ki_Teitzei",
    "כי תבא": "Parashat_Ki_Tavo",
    "נצבים": "Parashat_Nitzavim",
    "וילך": "Parashat_Vayeilech",
    "האזינו": "Parashat_Haazinu",
    "וזאת הברכה": "Parashat_Vezot_Haberakhah",
}

ORDERED_KEYS = list(API_MAP.values())
SEFARIA_BOOKS = ["Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy"]

REF_PATTERN = re.compile(r"^(?P<book>.+?)\s+(?P<start_ch>\d+):(?P<start_v>\d+)-(?P<end_ch>\d+):(?P<end_v>\d+)$")


def fetch_json(url: str):
    with urlopen(url, timeout=60) as response:
        return json.load(response)


def normalize_hebrew_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.replace("־", " ").replace("-", " ")).strip()


def parse_ref(ref: str):
    match = REF_PATTERN.match(ref.strip())
    if not match:
        return None
    data = match.groupdict()
    return {
        "book": data["book"],
        "start": (int(data["start_ch"]), int(data["start_v"])),
        "end": (int(data["end_ch"]), int(data["end_v"])),
    }


def maftir_is_within_torah(maftir_ref: str, torah_ref: str) -> bool:
    maftir = parse_ref(maftir_ref)
    torah = parse_ref(torah_ref)

    if not maftir or not torah:
        return True

    return (
        maftir["book"] == torah["book"]
        and torah["start"] <= maftir["start"]
        and maftir["end"] <= torah["end"]
    )


def get_maftir_map(is_israel: bool):
    result = {}
    flag = "on" if is_israel else "off"
    whole_refs = get_parsha_whole_refs()

    for year in range(2020, 2037):
        url = f"https://www.hebcal.com/hebcal?v=1&cfg=json&year={year}&yt=G&s=on&leyning=on&i={flag}"
        payload = fetch_json(url)

        for item in payload.get("items", []):
            if item.get("category") != "parashat":
                continue

            hebrew = item.get("hebrew", "")
            if not hebrew.startswith("פרשת "):
                continue

            name = normalize_hebrew_name(hebrew[5:])

            api_name = API_MAP.get(name)
            if not api_name:
                continue

            leyning = item.get("leyning", {})
            maftir = leyning.get("maftir")
            whole_ref = whole_refs.get(api_name)
            if not maftir:
                continue
            if whole_ref and not maftir_is_within_torah(maftir, whole_ref):
                continue

            result.setdefault(api_name, maftir.split("|")[0].strip())

    return result


def render_js_map(name: str, data: dict[str, str]) -> list[str]:
    lines = [f"    {name}: {{"]
    for key in ORDERED_KEYS:
        if key in data:
            value = data[key].replace('"', '\\"')
            lines.append(f'      {key}: "{value}",')
    lines.append("    },")
    return lines


def normalize_api_key(value: str) -> str:
    return re.sub(r"[\s_\-']", "", value.replace("Parashat_", "").lower())


def get_parsha_whole_refs() -> dict[str, str]:
    result: dict[str, str] = {}
    target_keys = {normalize_api_key(value): value for value in ORDERED_KEYS}

    for book in SEFARIA_BOOKS:
        payload = fetch_json(f"https://www.sefaria.org/api/index/{book}")
        for node in payload.get("alts", {}).get("Parasha", {}).get("nodes", []):
            shared_title = node.get("sharedTitle")
            whole_ref = node.get("wholeRef")
            if not shared_title or not whole_ref:
                continue

            normalized = normalize_api_key(shared_title)
            api_name = target_keys.get(normalized)
            if api_name and api_name not in result:
                result[api_name] = whole_ref

    return result


def main():
    diaspora = get_maftir_map(False)
    israel = get_maftir_map(True)

    lines = [
        "const MAFTIR_DATA = {",
        '  activeScheme: "diaspora",',
        "  schemes: {",
        *render_js_map("diaspora", diaspora),
        *render_js_map("israel", israel),
        "  },",
        "};",
        "",
    ]

    (ROOT / "maftir-data.js").write_text("\n".join(lines), encoding="utf-8")
    print(f"diaspora={len(diaspora)};israel={len(israel)}")


if __name__ == "__main__":
    main()

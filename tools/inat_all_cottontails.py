import requests
import time
import json
from pathlib import Path
import pandas as pd

STATE_LOCATIONS = {
    2: "Massachusetts",
    3: "Nebraska",
    4: "Delaware",
    5: "District of Columbia",
    6: "Alaska",
    7: "Virginia",
    8: "Rhode Island",
    9: "New Mexico",
    10: "Oregon",
    11: "Hawaii",
    12: "Oklahoma",
    13: "North Dakota",
    14: "California",
    15: "Wyoming",
    16: "Montana",
    17: "Maine",
    18: "Texas",
    19: "Alabama",
    20: "Indiana",
    21: "Florida",
    22: "Idaho",
    23: "Georgia",
    24: "Iowa",
    25: "Kansas",
    26: "Kentucky",
    27: "Louisiana",
    28: "Missouri",
    29: "Michigan",
    30: "North Carolina",
    31: "Ohio",
    32: "Wisconsin",
    33: "West Virginia",
    34: "Colorado",
    35: "Illinois",
    36: "Arkansas",
    37: "Mississippi",
    38: "Minnesota",
    39: "Maryland",
    40: "Arizona",
    41: "New Hampshire",
    42: "Pennsylvania",
    43: "South Carolina",
    44: "South Dakota",
    45: "Tennessee",
    46: "Washington",
    47: "Vermont",
    48: "New York",
    49: "Connecticut",
    50: "Nevada",
    51: "New Jersey",
}

SCRIPT_DIR = Path(__file__).parent.resolve()
OBSERVATIONS_URL = "https://api.inaturalist.org/v1/observations"

# iNaturalist API best practices say we should use the maximum page size
PER_PAGE_RESULTS = 200
SEARCH_PARAMS = {
    "captive": False,
    "identifications": "most_agree",
    "quality_grade": "research",
    # 52339 = New England
    "place_id": str(52339),
    # 43096 = Cottontail Rabbits
    "taxon_id": str(43096),
    # (term_id,term_value_id)=(17,18) => Alive
    # We are intentionally not filtering on this
    # 'term_id': str(17),
    # 'term_value_id': str(18),
    "per_page": str(PER_PAGE_RESULTS),
    "order_by": "id",
    "order": "asc",

    "photos": True,

    # Avoid licensing issues - filter to specific CC licenses
    "licensed": True,
    "license": ["cc-by", "cc-by-nc", "cc-by-sa", "cc-by-nc-sa", "cc0"],
    "photo_license": ["cc-by", "cc-by-nc", "cc-by-sa", "cc-by-nc-sa", "cc0"],
}


def get_annotation(rec: dict, attr_id: int) -> int | None:
    for annotation in sorted(
        rec.get("annotations", []),
        key=lambda anno: anno["vote_score"],
        reverse=True,
    ):
        if annotation["controlled_attribute_id"] == attr_id:
            return annotation["controlled_value_id"]
    return None

def simplify_record(record: dict) -> dict:
    print("Processing record: %d" % record["id"])

    is_alive = None
    match get_annotation(record, 17):
        case 18:
            is_alive = True
        case 19:
            is_alive = False
        case _:
            pass
    life_stage = get_annotation(record, 1)
    state = next(filter(lambda v: v[0] in record["place_ids"], STATE_LOCATIONS.items()))
    lat, lng = record["location"].split(",")
    main_photo = record["observation_photos"][0]["photo"]
    return {
        "occurrenceID": record["id"],
        "species": record["taxon"]["name"],
        "stateProvince": state[1],
        "isAlive": is_alive,
        "lifeStage": life_stage,
        "decimalLatitude": float(lat),
        "decimalLongitude": float(lng),
        "day": record["observed_on_details"]["day"],
        "month": record["observed_on_details"]["month"],
        "year": record["observed_on_details"]["year"],
        "licenseCode": record["license_code"],
        "photoID": main_photo["id"],
        "photoLicenseCode": main_photo["license_code"],
        "author": record["user"]["name"] or record["user"]["login"]
    }

def query_inat():    
    page = 1
    results = []

    s = requests.Session()
    s.headers["User-Agent"] = "cottontailfan"

    largest_id_seen = 0

    while True:
        got_anything = False
        this_round_results = []
        for i in range(5):
            print("Loading page %d (attempt %d)" % (page, i + 1))
            try:
                response = s.get(
                    OBSERVATIONS_URL, params=SEARCH_PARAMS | {"id_above": largest_id_seen}
                )
                assert response.status_code == 200
                print("Got data")
            except:
                # be nice to iNaturalist
                print("Failed, waiting 10 seconds")
                time.sleep(10)
                continue
            data = response.json()
            this_round_results = data["results"]
            got_anything = True
            break
        if not got_anything:
            raise RuntimeError(f"Failed at page {page}")
        results.extend(this_round_results)
        largest_id_seen = max(r["id"] for r in results)
        print(
            "We now have %d results. New highest ID is %d" % (len(results), largest_id_seen)
        )
        if not this_round_results:
            print("All done!")
            break
        page += 1
        time.sleep(2)

    print("Retrieved %d results" % len(results))

    results = list(
        sorted(
            filter(lambda r: r["time_observed_at"] is not None, results),
            key=lambda r: r["time_observed_at"],
        )
    )


    return results

DEBUG_LOCAL_LOAD = False

def main():
    if DEBUG_LOCAL_LOAD:
        print("Querying local data")
        results = json.load(open(SCRIPT_DIR / "raw_data" / "inat_all_cottontails_ne.json", 'r'))
    else:
        print("Querying online data")
        results = query_inat()
    print("Retrieved %d results" % len(results))

    results = list(filter(lambda r: r['observation_photos'], results))

    print("After filtering: %d results" % len(results))

    print("Generating processed records file")
    processed_results = [simplify_record(rec) for rec in results]

    df = pd.DataFrame(processed_results)
    with open(SCRIPT_DIR / "processed_data" / "inat_all_cottontails_ne.json", "w") as file:
        json.dump(processed_results, file, indent=4)
    df.to_csv(SCRIPT_DIR / "processed_data" / "inat_all_cottontails_ne.csv", index=False)
    living_only = list(filter(lambda rec: rec["isAlive"], processed_results))
    df = pd.DataFrame(living_only)
    with open(SCRIPT_DIR / "processed_data" / "inat_live_cottontails_ne.json", "w") as file:
        json.dump(living_only, file, indent=4)
    df.to_csv(SCRIPT_DIR / "processed_data" / "inat_live_cottontails_ne.csv", index=False)

main()
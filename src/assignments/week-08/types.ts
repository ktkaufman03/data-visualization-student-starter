// One iNaturalist observation, as produced by tools/inat_all_cottontails.py.
// See public/data/inaturalist-ne-cottontails-v3/README.md for what each field means.
export interface CottontailRow {
    occurrenceID: number;
    species: string;
    stateProvince: string;
    // Alive (true), dead (false), or not recorded (null).
    isAlive: boolean | null;
    // iNaturalist "Life Stage" annotation value: 2 = Adult, 8 = Juvenile. null if not recorded.
    lifeStage: number | null;
    decimalLatitude: number;
    decimalLongitude: number;
    day: number;
    month: number;
    year: number;
    mainPhotoID: number;
    // Photo license code (e.g. "cc-by-nc"), or null if none was given.
    license: string | null;
    author: string;
}

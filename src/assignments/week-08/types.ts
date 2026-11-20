// Several fields of the data are ignored because
// we just don't need them.
export interface CottontailRow {
    occurrenceID: string;
    species: string;
    stateProvince: string;
    occurrenceStatus: string;
    decimalLatitude: number;
    decimalLongitude: number;
    elevation: number;
    day: number;
    month: number;
    year: number;
}

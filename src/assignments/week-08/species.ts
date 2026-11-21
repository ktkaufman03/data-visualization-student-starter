// A fixed color for each species, shared by every view, so a species keeps its color no
// matter which other species are in the data. floridanus and transitionalis keep the colors
// they've had since week 4.
const SPECIES_COLORS: Record<string, string> = {
    "Sylvilagus floridanus": "#2a78d6",
    "Sylvilagus transitionalis": "#eb6834",
    // Identified only to genus, so it gets the neutral gray used for anything without a color.
    "Sylvilagus": "#898781"
};

export function speciesColor(species: string) {
    return SPECIES_COLORS[species] ?? '#898781';
}

// Reduces a subspecies (e.g. "Sylvilagus floridanus mallurus") to its species, the first two
// words of the name, so subspecies are counted with their species.
export function toSpecies(name: string) {
    return name.split(" ").slice(0, 2).join(" ");
}

// True for observations identified only to genus (a one-word name like "Sylvilagus").
export function isGenusOnly(species: string) {
    return !species.includes(" ");
}

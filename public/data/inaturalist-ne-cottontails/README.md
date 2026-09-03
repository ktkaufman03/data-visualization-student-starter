# Cottontail Observation Dataset

## Info

Source: [GBIF](https://www.gbif.org/occurrence/search?datasetKey=50c9509d-22c7-4a22-a47d-8c48425ef4a7&taxonKey=7QR2), based on "research-grade" data from [iNaturalist](https://www.inaturalist.org/). Additional filtering (primarily location-based) was applied on the data.

Citation (as requested by GBIF): GBIF.org (03 September 2026) GBIF Occurrence Download https://doi.org/10.15468/dl.rgw3ud

Concept: All observations of cottontail rabbits in (roughly) the New England region that were documented on iNaturalist and vetted by the community. My main reason for seeking out a dataset like this is because I'm interested in the vulnerable New England Cottontail, which has a very limited range as a result of being largely outcompeted by the Eastern Cottontail.

## Attributes

GBIF provides a lot of attributes, but I don't care about most of them because they're either administrative or redundant. So here are the ones I _do_ care about:

- occurrenceID (categorical): the link to the original iNaturalist submission
- species (categorical): the determined species of the observed cottontail. (The vast majority are documented as being Eastern cottontails, i.e., _Sylvilagus floridanus_)
- stateProvince (spatial): the state where the cottontail was observed
- occurrenceStatus (categorical): only "PRESENT" in the data I obtained, but it could theoretically be something else, which could be interesting
- decimal\[Latitude/Longitude\], elevation (spatial): the (approximate) [latitude/longitude/elevation] where the observation took place
- day/month/year (time): _when_ the observation took place
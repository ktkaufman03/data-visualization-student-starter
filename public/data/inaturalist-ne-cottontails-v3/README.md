# Cottontail Observation Dataset v3 (week 8 onwards)

## Info

Source: "research-grade" cottontail observation data from [iNaturalist](https://www.inaturalist.org/).

Concept: All observations of cottontail rabbits in (roughly) the New England region that were documented on iNaturalist and vetted by the community. My main reason for seeking out a dataset like this is because I'm interested in the vulnerable New England Cottontail, which has a very limited range as a result of being largely outcompeted by the Eastern Cottontail.

This data was obtained through the iNaturalist API, using the `tools/inat_all_cottontails.py` script. It only includes permissively-licensed observations. This method was necessary because GBIF doesn't include all the attributes I need.

For a _similar_ dataset:

> Source: [GBIF](https://www.gbif.org/occurrence/search?datasetKey=50c9509d-22c7-4a22-a47d-8c48425ef4a7&taxonKey=7QR2&stateProvince=Massachusetts&stateProvince=Connecticut&stateProvince=Rhode+Island&stateProvince=New+Hampshire&stateProvince=Maine&stateProvince=Vermont), based on "research-grade" data from [iNaturalist](https://www.inaturalist.org/).
>
> Citation (as requested by GBIF): GBIF.org (19 November 2026) GBIF Occurrence Download https://doi.org/10.15468/dl.ghukj7

The script produces two datasets:
- `inat_all_cottontails_ne` (all permissively-licensed observations)
- `inat_live_cottontails_ne` (all permissively-licensed observations of **living** cottontails - important for some new features)

## Attributes

- occurrenceID (categorical): the ID of the original iNaturalist submission
- species (categorical): the determined species of the observed cottontail. (The vast majority are documented as being Eastern cottontails, i.e., _Sylvilagus floridanus_)
- stateProvince (spatial): the state where the cottontail was observed
- isAlive (categorical): whether the observed cottontail was alive (true), dead (false), or "unknown" (null; i.e., the fact was not recorded at the time)
- decimal\[Latitude/Longitude\]: the (approximate) [latitude/longitude] where the observation took place
- day/month/year (time): _when_ the observation took place
- mainPhotoID (categorical): the ID of the submission's primary photo
- license (categorical): the submission's license, used for attribution statements
- author (categorical): the person to be credited for the submission
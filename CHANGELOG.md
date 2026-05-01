# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]


## [2026-05-01]

### Fixed

- `toppreise_highlighter.user.js`: non-favorited vendors (e.g. Buchmann) were misclassified as preferred because a `TPIcons-filledstar` icon also exists in the price-condition tooltip; star selectors are now scoped to `.Plugin_ShopLogo`

### Added

- `heise_newsticker_filter.user.js`: filter out unwanted stories, with collapsible "Kategorienfilter" 

### Changed

- Repo repurposed from single-script to multi-script collection
- README rewritten: generic installation section + scripts table with direct raw install links
- CONTRIBUTING.md filled in: naming convention, required metadata fields, local testing instructions
- `toppreise_highlighter.user.js`: updated `@namespace` to repo URL, added `@license MIT`

# Gamification & Engagement

## Overview

This module increases user retention and engagement through a badge-based achievement system and detailed campaign tracking for attribution.

## Key Components

### 1. Badge System

- **Class**: `Badge` (`classes/Badge.php`)
- **Concept**: Awards users for specific actions or milestones.
- **Structure**:
  - `id` & `slug`: Unique identifiers.
  - `set`: Grouping for badges.
  - `title` & `description`: User-facing text.
  - `hint`: Clue on how to unlock the badge.
  - `calls_to_action`: Messages encouraging further progress.
- **Triggers**: `BadgeActivityTrigger` allows defining events that automatically award badges.
- **Levels**: Badges can have multiple levels, supporting progressive achievement.

### 2. Campaign Tracking

- **Class**: `CampaignTracker` (`classes/CampaignTracker.php`)
- **Purpose**: Tracks marketing effectiveness.
- **Functionality**:
  - **UTM Parameters**: Captures `utm_source`, `utm_medium`, `utm_campaign`, etc., from the URL on landing.
  - **Referrer**: Captures `HTTP_REFERER` on the first visit.
  - **Persistence**: Stores data in cookies until registration, then associates it with the created User record.
- **Configuration**: `UserConfig::$campaign_variables` defines which URL parameters to track.

### 3. Cohorts

- **Class**: `Cohort` (`classes/Cohort.php`)
- **Purpose**: Groups users based on signup date or other shared characteristics for analysis.
- **Usage**: Helps in analyzing retention rates and feature usage over time.

## User Experience

- **Notifications**: Users are notified when badges are unlocked.
- **Profile**: Badges are displayed on the user's public or private profile (`show_badge.php`).

---
layout: page
title: Spot Your Mood!
description: Hackathon project using Spotify API for user mood -> music suggestions
img: assets/img/spotify.jpg
importance: 2
category: fun
giscus_comments: false
---

<iframe width="75%" height="400" 
                    src="https://youtube.com/embed/UaUhAYyHwYQ" frameborder="0"
                    allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen=""></iframe>
[[Full Code]](https://github.com/itswin/tartanhacks21)

# Overview

We used the Spotify API in conjuction with Google's NLP API to create an app that
classified the mood of your songs. In addition to classification, we were able to query certain
moods from a user and output songs that had the most correlation to the mood that the user wanted.

# Implementation

Given a user mood, we first transformed it into a mood vector.
From there, we used Spotify's API to find a subset of songs with similar mood vectors. From
here, we created a further embedding that used both spotify's
mood vector and our sentiment analysis result and found the song with the highest dot product
with the original user mood vector

We also used a similar process to generate a curated playlist given a specific mood, as well as
added ability to log in to your current spotify account and save said playlilst.
Finally, we created a function to plot mood over time, so the user could see how the mood of
their music changed over some time period.
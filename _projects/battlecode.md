---
layout: page
title: BattleCode!
description: Annual strategy-based coding competition run by MIT
img: assets/img/BattleCode.png
importance: 1
category: fun
related_publications: false
---

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/battleCodeMIT.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
<b>Partners</b>: <a class="text"
                        href="https://www.linkedin.com/in/winston-cheung/">Winston Cheung (left)</a>,
                    <a class="text" href="https://www.linkedin.com/in/david-lyons-cmu/">David Lyons (not shown)</a>,
                    <a class="text" href="https://www.bharathsreenivas.net/">Bharath Sreenivas (middle)</a></div>


Battlecode is an MIT AI competition run every year throughout the month of January with
100s of teams and thousands of participants entering code. As a general overview, games consist of two teams, each with control of some number of robots. These robots have different
abilities(making money, attacking, creating more robotos, etc),
and can only communicate through bitFlags whose messages must be coded up in some finite range. Some strategies for performing well include implementing fast pathfinding to navigate terrain with different levels of movement allowed per square, clustering troops to place them strategically across the map, and using map symmetry to infer the location of the enemy base long before actually exploring the entire map. 

There are multiple tournaments throughout the month, ending in a tournament for the top 16 teams getting flown out to MIT for cash prizes. We were lucky enough to be
in the top 16 for the three years we competed (2020, 2021, 2022), with monotonically decreasing rankings for each year. Our first year, we placed 9th-12th, the best performance out of all first time teams. The next year, we placed 7th-8th, and our final year we placed 3rd. **Our team name was always some variant of The N Musketeers.**

<h2> 2023 Overview</h2>

[[Full Code]](https://github.com/maxwelljones14/BattleCode2023) [[Full Post Mortem]](https://battlecode.org/assets/files/postmortem-2023-4-musketeers.pdf)
 <iframe width="560" height="315" src="https://www.youtube.com/embed/oa4CAizd1Nk?start=8810"
                    title="YouTube video player" frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen></iframe>


This year, we worked really hard to make a post mortem that is both easy to read and
informative for any level of reader. Please feel free to give it a skim/read some paragraphs
that are of most interest (the table of contents has links to each section, so you can just
click on a section to go there)!

<h2> 2022 Overview</h2>

[[Full Code]](https://github.com/BSreenivas0713/Battlecode2022) [[Full Post Mortem]](https://battlecode.org/assets/files/postmortem-2022-5-musketeers.pdf)
 <iframe width="560" height="315" src="https://www.youtube.com/embed/X5d00wtBX3k?start=5832&end=6027"
                    title="YouTube video player" frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen></iframe>


Here are some of the cooler features from this year:
- Like in 2021, we used a stack to store states (look at the first bullet 2021 for more
                                info)
- We used a distributed k clustering algorithm for troop movements. All troops reported
                                enemy troops in their range to the main tower, which then found at most 3 main enemy
                                clusters. From here our troops went towards their closest cluster
- We spent a lot of time on troop to troop micro-interactions. for deciding whether to
                                attack at a micro level, we considered how many troops we had vs how many troops the
                                enemy had as well as health, cooldown, and land passability


<h2> 2021 Overview</h2>
[[Full Code]](https://github.com/maxwelljones14/BattleCode2023) [[Full Post Mortem]](https://battlecode.org/assets/files/postmortem-2021-musketeers.pdf)
 <iframe width="560" height="315" src="https://youtube.com/embed/WZrlJAE3LKw"
                    title="YouTube video player" frameborder="0"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowfullscreen></iframe>


Here are some of the cooler features from this year:
- Our home base towers used a stack to store different States. With this in place, we
                                could switch from a state like Default to defending, while pushing Default to the stack.
                                Once we were done defending, we could pop the State Stack and go back to Default mode.
                                This allowed us to do a lot of tasks as intermediates while still having main tasks
- We used priority queues that stored locations of enemy bases, giving priority to those
                                that had the least amount of money, to effectively take over enemy bases when possible
- We used bit manipulation to communicate between towers, which all had 24 bit flags that
                                robots in sensor radius could see

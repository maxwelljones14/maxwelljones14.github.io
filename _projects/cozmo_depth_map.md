---
layout: page
title: Cozmo Depth Map
description: monocluar absolute depth estimation using robotics x deep learning
img: assets/img/living_room_depth_map.png
importance: 3
category: course project
---

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/3_cubes.png" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
    Screenshot of our overall method. The robot uses markers to predict absolute depth for up to 3 cubes. We then use these absolute depth predictions with a relative monocular depth prediction from <a class="text" href="https://github.com/isl-org/MiDaS">MiDaS</a> to predict absolute depth at every pixel
</div>

[[Codebase]]("https://github.com/maxwelljones14/Cog_Robo_Final_Project") [[Presentation Slides]](../../assets/pdf/cozmo_depth_map_presentation_slides.pdf)

Partner: [Akshath Burra](https://www.linkedin.com/in/arburra/)

My senior year I took [Cognitive
Robotics](http://www.cs.cmu.edu/afs/cs.cmu.edu/academic/class/15494-s23/), a course in which you program [Cozmo](https://www.digitaldreamlabs.com/products/cozmo-robot), a robot with a camera sensor. Our goal was to estimate absolute depth of every pixel seen by the camera sensor 

# Implementation

Thanks to CMU, cozmo also had access to a ~8 GB GPU. For our final project, my partner
Akshath and I decided to use [MiDaS](https://github.com/isl-org/MiDaS),
a monocular depth model,
to predict depth at every frame that Cozmo sees. 

Since MiDaS only gives relative depth,
this depth map is not grounded with real world depth values. However, when Cozmo sees a
**light cube**, a special object with an aruco marker, he knows how far away this light cube is. Using light cubes as a sparse depth signal, we
calculate an optimal scaling factor to multiply to the relative MiDaS depth map to give an
accurate depth map of the image, which
can then be queried at any pixel. Feel free to look at the slides linked above for a full
explanation and [proof of optimality](../../assets/pdf/depth_proof.pdf) for our scaling
factor!

<iframe width="560" height="315" src="https://www.youtube.com/embed/sjX_GxfMVb0"
title="YouTube video player" frameborder="0"
allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
allowfullscreen></iframe>

Demo
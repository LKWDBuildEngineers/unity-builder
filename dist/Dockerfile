ARG IMAGE
FROM $IMAGE

LABEL "com.github.actions.name"="Unity - Builder"
LABEL "com.github.actions.description"="Build Unity projects for different platforms."
LABEL "com.github.actions.icon"="box"
LABEL "com.github.actions.color"="gray-dark"

LABEL "repository"="http://github.com/webbertakken/unity-actions"
LABEL "homepage"="http://github.com/webbertakken/unity-actions"
LABEL "maintainer"="Webber Takken <webber@takken.io>"

ADD default-build-script /UnityBuilderAction
ADD steps /steps
RUN chmod -R +x /steps
ADD entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
RUN ls

COPY ./config/libmp3lame.so /opt/unity/Editor/Data/Tools/FSBTool/libmp3lame.so

RUN apt-get update \
  && apt-get -q install -y --no-install-recommends --allow-downgrades \
    lame \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /usr/share/unity3d/config
COPY ./config/services-config.json /usr/share/unity3d/config/services-config.json



ENTRYPOINT ["/entrypoint.sh"]

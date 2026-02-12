pipeline {
    agent any
    environment {
        // A jelenlegi mappát hozzáadjuk az útvonalhoz, hogy a ./docker parancs működjön
        PATH = "${WORKSPACE}:${PATH}"
    }
    stages {
        stage('Setup Tools') {
            steps {
                script {
                    // 1. Letöltjük a Docker klienst (Linux verziót, mert a Jenkins Linuxon fut)
                    echo 'Downloading Docker CLI...'
                    sh 'curl -fsSLO https://download.docker.com/linux/static/stable/x86_64/docker-24.0.5.tgz'
                    
                    // 2. Kicsomagoljuk a klienst
                    sh 'tar xzvf docker-24.0.5.tgz --strip 1 -C . docker/docker'
                    
                    // 3. Letöltjük a Kubectl-t (ahogy eddig is)
                    echo 'Downloading Kubectl...'
                    sh 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"'
                    sh 'chmod +x kubectl'
                }
            }
        }
        stage('Build Docker Image') {
            steps {
                // Most már használhatjuk a ./docker parancsot
                // A ./docker azt jelenti: "itt van a lábam alatt a program, ezt használd"
                sh './docker build -t my-node-app:latest ./app'
            }
        }
        stage('Deploy to K8s') {
            steps {
                // A Kubectl-t is lokálisan hívjuk meg
                sh './kubectl rollout restart deployment backend-deployment'
            }
        }
    }
}